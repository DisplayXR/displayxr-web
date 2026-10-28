# starter-world — a first-person walk-through

A small furnished room you walk through with WASD / the arrow keys and look around by dragging. It
runs on a **camera rig**: the page owns its camera, the runtime turns it into two eyes. Use it for
a game, a flythrough, an editor or a ported WebXR scene.

**Rules it demonstrates** ([Making 3D that looks right](../../docs/making-3d-look-right.md)):
rule 1 (the user moves through a world → camera rig), rule 2 (one **fixed, finite** convergence,
never gaze-driven, never 0, chosen so that the outer ~10 % of every edge — floor, walls, ceiling,
furniture against the walls — is at or behind the glass at **every reachable pose**: convergence
1.6 m, walls and furniture kept 2.5 m away, pitch limited to ±30°), rule 3 (full-frame budget:
with the plane that near, `ipdFactor` 0.5 keeps even infinity at ≤ 0.96 % of the width), rule 4
(nothing in front of the glass at the edges; furniture only along the walls, an open middle),
rule 5 (the attach
pattern: an identity-posed `cameraRigFromCamera(…, { attach: true })` sent once and the eye
cameras parented under the app camera; views validated before the clear and the last good frame
replayed; opaque clear; pixel ratio 1; canvas sized before it is registered and afterwards only in
`onResize`; `depthNear`/`depthFar` from the camera), rule 6 (the HUD at the top, where the ceiling
is behind the glass; plain `rgba()` background), rule 7 (cover until `firstWoven`), rule 9 (the same
camera drawn once in an ordinary browser).

**Check a pose in code.** `checkReachablePoses()` (open the page with `?check`) walks the corners
of the walkable area at every 15° of yaw and both pitch limits, casts rays through the outer 10 %
of every edge, and turns each hit into disparity with `cameraRigDisparityPct()` from
`@displayxr/inline3d/depth`, using the same rig numbers the runtime gets. It reports the nearest
edge content (0.00 %: on the glass, nothing in front) and the farthest (+0.83 %).

Measured by the headless stereo judge (% of the tile width; full-frame comfortable ≥ −0.3 / ≤ 1.0):

| pose | front p2 | behind p98 | edges |
|---|---|---|---|
| start | +0.47 | +0.82 | 0.000 |
| far-left corner, turned to the wall, looking down at the limit | +0.05 | +0.60 | 0.000 |
| right side, facing the sofa wall | +0.34 | +0.52 | 0.000 |

**Why the clearance is ~1.5× the convergence, not half of it.** A wall you face squarely is all at
its distance, and the frame's corner rays reach a wall seen at an angle sooner still: at worst
`1/√(1 + tan²(hfov/2) + tan²(vfov/2)) ≈ 0.65` of its distance on a 16:9, 60° frame. Half the
convergence would put a faced wall about 2 % of the width in front of the glass.

## Adapt it

- **Your world:** replace the room section. Keep it in metres: on a camera rig the eye separation
  is absolute (63 mm × `ipdFactor` × `metersToVirtual`).
- **Eye height / field of view / room size:** change them, then re-run `?check` and trade the three
  knobs (`CONVERGENCE`, `CLEAR`, `PITCH_MAX`) until the nearest edge content is ≥ 0 %. A bigger
  room allows a farther convergence (and a larger `IPD`); furniture in the open needs the same
  clearance as a wall all round it.
- **Several rooms:** convergence may change with where the visitor is (a new room, a corridor),
  eased over a second or more — never with where they look.
- **Far content:** the farthest visible point sets the "behind" number,
  `100 · 0.063 · (1/D − 1/z) / (2 · tan(fov/2) · aspect)` % of the width. Open sky (`1/z = 0`) is
  the largest: fog it, bring it in, or lower `ipdFactor`.
- **Changing convergence:** only on a cut or when entering a new space, and slowly — never from
  what is under the cursor.

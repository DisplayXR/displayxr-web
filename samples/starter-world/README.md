# starter-world — a first-person walk-through

A small furnished room you walk through with WASD / the arrow keys and look around by dragging. It
runs on a **camera rig**: the page owns its camera, the runtime turns it into two eyes. Use it for
a game, a flythrough, an editor or a ported WebXR scene.

**Rules it demonstrates** ([Making 3D that looks right](../../docs/making-3d-look-right.md)):
rule 1 (the user moves through a world → camera rig), rule 2 (a **fixed, finite** convergence at
the nearest content that touches a frame edge — the floor at the bottom edge, `0.9 · EYE_H /
tan(fov/2)` ahead — never gaze-driven, never 0), rule 3 (full-frame budget; a closed room, no
window onto infinity), rule 4 (nothing in front of the glass at the edges), rule 5 (the attach
pattern: an identity-posed `cameraRigFromCamera(…, { attach: true })` sent once and the eye
cameras parented under the app camera; views validated before the clear and the last good frame
replayed; opaque clear; pixel ratio 1; canvas sized before it is registered and afterwards only in
`onResize`; `depthNear`/`depthFar` from the camera), rule 6 (the HUD at the top, where the ceiling
is behind the glass; plain `rgba()` background), rule 7 (cover until `firstWoven`), rule 9 (the same
camera drawn once in an ordinary browser).

Measured by the headless stereo judge at the start pose: front p2 +0.2 % (nothing in front),
behind p98 +0.9 % of the tile width (full-frame comfortable: ≥ −0.3 % / ≤ 1.0 %).

## Adapt it

- **Your world:** replace the room section. Keep it in metres: on a camera rig the eye separation
  is absolute (63 mm × `ipdFactor` × `metersToVirtual`).
- **Eye height / field of view:** change `EYE_H` and `FOV`; `CONVERGENCE` follows. If something
  else is the nearest thing touching an edge (a cockpit frame, a desk), converge on it instead.
- **Far content:** the farthest visible point sets the "behind" number,
  `100 · 0.063 · (1/D − 1/z) / (2 · tan(fov/2) · aspect)` % of the width. Open sky (`1/z = 0`) is
  the largest: fog it, bring it in, or lower `ipdFactor`.
- **Changing convergence:** only on a cut or when entering a new space, and slowly — never from
  what is under the cursor.

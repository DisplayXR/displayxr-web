# Depth and comfort on a 3D display

The SDK's defaults already give comfortable, real-looking 3D. These rules cover the mistakes seen
on real panels; everything else about how your scene looks is your call.

1. **Objects: keep the viewer's placement, and frame the first view.** `addModel`, `addSplat` and
   `SceneViewer` scale the subject to its real proportions and centre it on the glass. That gives
   it the smallest spread of disparity it can have. Don't push it back, shrink it or flatten it to
   make it "more comfortable". The first view shows the whole subject, centred: a globe or a tank
   that starts low and cut off by the frame reads as broken. If the user can zoom, cap zoom-in
   before the subject comes uncomfortably far out, and leave room to zoom out.
2. **Lay flat arrangements back into depth.** Orbits, a map, a board game: tilt the plane they lie
   in back from the glass so it recedes, rather than looking straight down on it, where it reads
   as flat circles. A chart, a figure or a building starts upright.
3. **Moving things: keep the forward swing small.** Objects that orbit, fly or swing toward the
   viewer are where pop-out becomes uncomfortable. Keep their paths mostly at or behind the glass,
   and fade them out as they come close to the viewer. A follow camera keeps its subject in frame
   on fast moves.
4. **Worlds: keep convergence fixed, and keep near things away.** On a camera rig, set
   `convergence` once for the scene, or change it slowly when the scene changes. Never set it from
   where the user is looking: whatever they look at lands on the glass and goes flat. Never set it
   to 0. Near geometry is where a world goes wrong: a window frame, a wall or a crossbar close to
   the camera comes far out of the glass and ghosts. Keep the visitor's camera well clear of
   walls and furniture, or lower `ipdFactor` while it is close.
5. **Low contrast between the subject and what is behind it.** The display's crosstalk correction
   works only within the range of the image, so a bright edge on black ghosts first. A light or
   mid-tone, low-contrast background works best: a real texture or a soft gradient, not generated
   noise. A dark grey is the minimum, and pure black is the worst case; keep the subject's darkest
   faces above the background. Soften high-contrast detail far from the glass in the colours and
   materials, not with fog, since camera-distance fog follows the viewer's head.
6. **Text: flat HTML near the glass, at a readable size.** Text drawn in the 3D scene, especially
   white on dark, ghosts. Put titles, labels and values in HTML, or keep in-scene labels close to
   the glass, facing the viewer, and show them on hover. Never shrink text to hide ghosting.
7. **No coplanar surfaces.** Z-fighting (two faces at the same depth flickering through each
   other) is the most common defect seen on panels, and in 3D it reads as shimmer at one depth.
   Offset decals, shadows, shelf faces and picture frames from the surface they sit on. Keep
   geometry solid: no paper-thin or floating floors, no holes in rocks, nothing clipping through
   glass.
8. **No detail finer than a few pixels.** Thin lines, single-pixel stars and fine repeating
   patterns alias and shimmer as the head moves. Draw them thicker, softer or as sprites, and size
   textures to their surfaces instead of stretching them.
9. **A cover over the canvas must always come off.** If you hide the canvas until `firstWoven`,
   also remove the cover after a few seconds and if your setup throws. Otherwise a missed signal
   leaves the page with its UI and no scene.

The mechanics (one view per eye, CSS that breaks the weave, the 2D/3D switch) are in
[woven-canvas-rules.md](woven-canvas-rules.md) and [authoring-inline-3d.md](authoring-inline-3d.md),
which also gives the comfort zone in diopters and how the same content changes from a large
monitor to a phone. The samples show how the API works, not how a page should look.

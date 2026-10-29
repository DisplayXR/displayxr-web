# Depth and comfort on a 3D display

The SDK's defaults already give comfortable, real-looking 3D. These rules cover the mistakes seen
on real panels; everything else about how your scene looks is your call.

1. **Objects: keep the viewer's placement.** `addModel`, `addSplat` and `SceneViewer` scale the
   subject to its real proportions and centre it on the glass. That gives it the smallest spread
   of disparity it can have. Don't push it back, shrink it or flatten it to make it "more
   comfortable". One exception: a sphere or a dome (a globe, a planet) centred on the glass shows
   only its front half, all of it in front of the glass; move it back until its rim is about at
   the glass.
2. **Worlds: keep convergence fixed, and keep near things away.** On a camera rig, set
   `convergence` once for the scene, or change it slowly when the scene changes. Never set it from
   where the user is looking: whatever they look at lands on the glass and goes flat. Never set it
   to 0. Near geometry is where a world goes wrong: a window frame, a wall or a crossbar close to
   the camera comes far out of the glass and ghosts. Keep the visitor's camera well clear of
   walls and furniture, or lower `ipdFactor` while it is close.
3. **Low contrast between the subject and what is behind it.** The display's crosstalk correction
   works only within the range of the image, so a bright edge on black ghosts first. A light or
   mid-tone, low-contrast, textured background works best; a dark grey is the minimum, and pure
   black is the worst case. Fading the frame edges helps too. Soften high-contrast detail far from
   the glass in the colours and materials, not with fog, since camera-distance fog follows the
   viewer's head.
4. **Text: flat HTML near the glass, at a readable size.** Text drawn in the 3D scene, especially
   white on dark, ghosts. Put titles, labels and values in HTML, or keep in-scene labels close to
   the glass and show them on hover. Never shrink text to hide ghosting.
5. **No detail finer than a few pixels.** Thin lines, single-pixel stars and fine repeating
   patterns alias and shimmer as the head moves. Draw them thicker, softer or as sprites. Avoid
   coplanar surfaces (z-fighting reads as flicker in 3D), and size textures to their surfaces
   instead of stretching them.
6. **A cover over the canvas must always come off.** If you hide the canvas until `firstWoven`,
   also remove the cover after a few seconds and if your setup throws. Otherwise a missed signal
   leaves the page with its UI and no scene.

The mechanics (one view per eye, CSS that breaks the weave, the 2D/3D switch) are in
[woven-canvas-rules.md](woven-canvas-rules.md) and [authoring-inline-3d.md](authoring-inline-3d.md),
which also gives the depth ranges measured on a panel. The samples show how the API works, not how
a page should look.

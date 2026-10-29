# Depth and comfort on a 3D display

The SDK's defaults already give comfortable, real-looking 3D. Four rules cover the mistakes seen
on real panels; everything else about how your scene looks is your call.

1. **Objects: keep the viewer's placement.** `addModel`, `addSplat` and `SceneViewer` scale the
   subject to its real proportions and centre it on the glass. That gives it the smallest spread
   of disparity it can have. Don't push it back, shrink it or flatten it to make it "more
   comfortable".
2. **Worlds: keep convergence fixed.** On a camera rig, set `convergence` once for the scene, or
   change it slowly when the scene changes. Never set it from where the user is looking: whatever
   they look at lands on the glass and goes flat. Never set it to 0.
3. **No pure black behind a bright subject.** The display's crosstalk correction can't go darker
   than black, so a bright edge on black doubles first. Use a dark grey for the background and the
   page around the canvas. Avoid very high-contrast detail far from the glass: soften it in the
   colours and materials, not with fog, since camera-distance fog follows the viewer's head.
4. **A cover over the canvas must always come off.** If you hide the canvas until `firstWoven`,
   also remove the cover after a few seconds and if your setup throws. Otherwise a missed signal
   leaves the page with its UI and no scene.

The mechanics (one view per eye, CSS that breaks the weave, the 2D/3D switch) are in
[woven-canvas-rules.md](woven-canvas-rules.md) and [authoring-inline-3d.md](authoring-inline-3d.md).
The samples show how the API works, not how a page should look.

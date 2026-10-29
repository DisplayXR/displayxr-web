# Making 3D that looks right

**Read this first**, whether you are a person or a coding agent. The SDK's defaults already give
good 3D: the viewers scale an object to real proportions and centre it on the glass, and that is
what the reference apps do. Most pages that look wrong do so because they changed a default.
This page lists the few decisions that are yours, and the mistakes seen on real panels.

The SDK never stops you from doing anything below. If you have a reason to break a rule, do it on
purpose and check the result on a panel.

## The rules

1. **Choose the rig by what the user moves.** They turn an object → **display rig**. They move
   through a world → **camera rig**. ([§1](#1-choose-the-rig))
2. **An object scene: keep the defaults.** Leave the subject the size and place the viewer gives
   it, centred on the glass. Don't push it back, shrink it or flatten it.
   ([§2](#2-object-scenes-keep-the-defaults))
3. **A world: fixed, finite convergence.** Never drive it from where the user looks, and never set
   it to 0. ([§3](#3-worlds-a-fixed-finite-convergence))
4. **Dark grey, not black, behind the subject.** ([§4](#4-background-and-contrast))
5. **Nothing in front of the glass touches a frame edge or sits under 2D UI.**
   ([§5](#5-composition))
6. **Draw each eye with its own view.** Use the SDK's viewers, or `EyeCamera`; never one camera for
   both eyes. ([§6](#6-draw-each-eye-correctly))
7. **2D UI is HTML at the glass.** No CSS `filter`, `backdrop-filter`, `opacity` or animated
   `transform` on, around or over the 3D canvas. ([§7](#7-2d-ui))
8. **A cover over the canvas must always come off.** ([§7](#7-2d-ui))
9. **A depth slider moves `ipdFactor` and `parallaxFactor` together; offer a 2D/3D switch; work in
   an ordinary browser.** ([§8](#8-depth-slider-2d3d-switch-ordinary-browser))

## The mental model

- The page's `<canvas>` is a window onto a 3D scene. The browser draws one image per eye into it
  side by side, and the display **weaves** them so each eye sees its own.
- The **glass** is the zero-disparity plane, `z = 0` in display space. **`+z` comes out of the
  glass toward the viewer; `−z` goes behind it.**
- **Disparity** is how far apart a point lands in the two eyes' images. Too much → **double
  image**. None at all (or the same image twice) → **flat**.
- The glass is the only plane with no crosstalk. The further content is from it, the more the
  panel's ghosting can show, most of all on high-contrast edges.
- You declare a **view rig**; the browser and runtime compute the eye views from it. You never
  compute stereo yourself.
- In an ordinary browser the same page runs in 2D: one view, no weave.

## 1. Choose the rig

Decide by **what the user moves**, not by whether your code has a camera.

| The user… | Examples | Rig | Use |
|---|---|---|---|
| turns or inspects **an object** | product viewer, figurine, splat of a thing, a tabletop diorama, a chart, a globe | **display rig** | `addModel`, `addSplat`, `SceneViewer` (`./viewer`), or `addScene` with `displayRig()` |
| **moves through a world** | first-person walk-through, game, flythrough, ported WebXR/VR | **camera rig** | `addScene` + `EyeCamera` + `cameraRigFromCamera(…, { convergence })` |
| looks at a **captured photo or video** | stereo pair, SBS video, photo splat with a capture camera | the **capture's own rig** | `addImage`, `addPlayer`, `addSplat` (reads the asset's camera block) |

The sharpest test: **if a camera rig would need a scale fudge to look right, you wanted a display
rig.** A display rig scales the subject into a virtual display `virtualDisplayHeight` tall, so its
depth does not depend on how big it is in world units. A camera rig plants two eyes 63 mm apart at
your camera; a big subject far from that camera goes flat.

Long form: [authoring-inline-3d.md § Which rig](authoring-inline-3d.md#which-rig--decide-by-what-the-user-moves-not-by-whether-you-hold-a-camera).

## 2. Object scenes: keep the defaults

The viewers (`addModel`, `addSplat`, `SceneViewer`, and `addScene` with `displayRig()` as in
[`hello-cube`](../samples/hello-cube/)) fit the subject to the tile and centre it on the glass, at
its real proportions. That is the right placement for an object: the glass runs through the middle
of the subject, so it has the **smallest spread of disparity** it can have for its size, half in
front and half behind. Keep it:

- **Don't push the subject back** (`depthOffset` < 0) to reduce pop-out. It moves the whole
  subject off the glass and increases the largest disparity in the scene.
- **Don't shrink it or zoom it out** to buy comfort (`margin`, `depthFit`, `zoom.min` < 1, a
  smaller model). On the panel it just looks small.
- **Don't flatten it** (`scale.z`, a lower `ipdFactor` by default). An object with almost no depth
  reads as a picture.
- **Do keep the shape real.** Uniform scale only; never scale one axis.

Tune away from the defaults only for what you have seen on a panel: a scene that is unusually deep
for its height (a long corridor of bars, a far backdrop inside the subject), or a subject that
comes out of the glass at a frame edge. `handle.depthReport()` reads where the subject sits now.

**Backdrops are not the subject.** Put a floor, a sky or a far backdrop in the scene around the
subject (`viewer.scene`, not `viewer.content`), or the viewer fits and centres the backdrop instead
of the subject.

## 3. Worlds: a fixed, finite convergence

On a camera rig, `convergence` is the distance that lands on the glass. Nearer is in front,
farther is behind.

- **Set it on the subject region of the world** (the middle of the room, the track ahead), so the
  floor and walls that reach the frame edges are at or behind the glass.
- **Keep it fixed**, or change it slowly with the scene (a new room). **Never drive it from what is
  under the cursor or the centre of the view.** Whatever you look at then lands on the glass, so
  the thing you are looking at is always flat, and the depth changes with every glance.
- **Never `convergence: 0`** (infinity): the whole scene floats in front of the glass.
- Author the world in **metres** and leave `ipdFactor` at 1 unless a panel shows doubling; the
  eyes are then your real eyes.
- On a camera rig the background at infinity has the largest disparity in the scene. A sky or a
  far mountain range works; a sharp, bright starfield or skyline at infinity is where doubling
  starts. Fog it or bring it in.

`cameraRigDisparityPct()` (`@displayxr/inline3d/depth`) gives the disparity of any point, so you
can check a pose in code.

**A captured photo or video with no single subject** (a wide shot, a landscape): put the screen
plane so **about 20 % of the frame is in front of the glass**. Stereographers on native-stereo
feature films put zero disparity at roughly the 78th percentile of nearness (centre-weighted),
measured over 2,121 shots of 19 titles. Don't let a big flat background decide the plane.

Move the plane smoothly (a second or more, no overshoot) or cut; never jump it.

## 4. Background and contrast

The panel corrects for crosstalk, but it can't correct a bright edge against pure black: there is
no darker level to subtract into. That is where a double image shows first, and an object on a
black page is exactly that case.

- **Use a dark grey, not black, behind an object** (about `#1a1c20` to `#2a2d33`), in the clear
  colour and in the page colour around the canvas, and match the two.
- **Avoid sharp, high-contrast silhouettes far from the glass**: white on black, specular glints,
  fine high-contrast patterns. Soften them, or keep them near the glass.
- Keep **thin text at the glass**, as HTML.

## 5. Composition

1. **Nothing in front of the glass touches a frame edge.** An edge cutting through pop-out content
   breaks the illusion at once: the edge is at the glass and the content is in front of it. Let
   anything that crosses an edge sit at or behind the glass.
2. **Nothing in front of the glass sits under HTML.** Put UI where the picture is at or behind the
   glass, or draw the label in the scene.
3. **Keep the eye separation fixed** in a continuous shot. A baseline that adapts to the scene
   reads as the world breathing.
4. **A frame hitch reads as "tracking froze".** Warm shaders before first use (`warmEntity`,
   `warmEffect`), and slice heavy work.

## 6. Draw each eye correctly

**Prefer the SDK's own viewers** (`addModel`, `addSplat`, `addImage`, `addPlayer`, `SceneViewer`).
Write your own loop only when you need to, and then follow a template's loop exactly
([`hello-cube`](../samples/hello-cube/) on a display rig,
[`camera-rig`](../samples/camera-rig/) on a camera rig):

- Draw **every view** with **its own** `projectionMatrix` and `transform`, into **its own**
  `layer.getViewport(view)`. In three.js use `EyeCamera`. One camera for both eyes gives the same
  image twice, which looks flat.
- **Check the views before clearing**: if a frame has fewer views than you expect, keep the last
  good frame on screen instead of clearing or skipping.
- **Pixel ratio 1** on the renderer: the SDK sizes the canvas; don't multiply it again.
- Size the canvas **before** you register it, and resize only in the SDK's `onResize`.
- **Near and far are always yours:** no SDK viewer calls `updateRenderState`. Set them once the
  session is up: `wall.session.updateRenderState({ depthNear: camera.near, depthFar: camera.far })`.
- A transparent clear with `EdgeFeather` (as in `hello-cube`) is fine. With a transparent clear,
  the page colour behind the canvas shows through; make it the §4 dark grey.

## 7. 2D UI

- **Text and controls are HTML, at the glass**, where the picture is at or behind the glass.
- **No render-surface CSS on, around or over the canvas:** no `filter` (including on hover), no
  `backdrop-filter`, no `opacity` below 1, no `mix-blend-mode`, no animated `transform`, on the
  canvas, any ancestor, or anything drawn over it. Any of these can take the canvas out of the
  weave, and it goes flat. A translucent `rgba()` colour on UI is fine.
- **A HUD over a world goes where the world is behind the glass**: the top, or a side column; not
  over the floor at the bottom.
- **One canvas for the whole page.** Don't remount or recreate it between screens.
- **A cover over the canvas must always come off.** Covering the canvas until `handle.firstWoven`
  resolves hides the squeezed side-by-side flash on load. Also remove the cover on a timer (about
  3 s) whatever happens, and remove it if your setup code throws. A cover that waits on one signal
  that never arrives leaves a page with its UI and no scene, and in the page's own colour it looks
  as if the 3D simply isn't there. Remove it in one step; never fade it.
- **Cut between scenes, don't crossfade two canvases.**

Long form: [woven-canvas-rules.md](woven-canvas-rules.md).

## 8. Depth slider, 2D/3D switch, ordinary browser

**Depth slider.** Map one slider value `k` in `[0, 1]` (default 1) to **both** `ipdFactor` and
`parallaxFactor`, so the look-around shrinks with the depth:

```js
// display rig (addScene / SceneViewer)
handle.setViewRig(displayRig({ virtualDisplayHeight: 0.24, ipdFactor: k, parallaxFactor: k }));
// addSplat handle
splat.setStereo({ ipdFactor: k, parallaxFactor: k });
```

On a display rig the factors are relative (`1` = what the display does naturally), so the slider
can only make the scene shallower. Never implement it by scaling the scene's `z`.

**2D/3D switch.** `setStereoEnabled(false)` asks the display for its flat mode; `true` returns to
3D. Call it on the tile handle from `addScene`, or on `wall` (from `createInline3D()`) with
`addModel`/`addSplat`. It rejects where the display has no flat mode, so catch it and fall back to
the slider at 0. Write the toggle so it cannot invert: `await wall.setStereoEnabled(!in3D)`, and
set `in3D` only from the `renderingmodechange` event.

**The ordinary browser.** `createInline3D()` resolves `{ supported: false }` without the 3D API.
The SDK viewers then render a normal 2D view on their own; with `addScene`, draw one view with a
normal camera. The page must look finished in 2D.

## 9. Templates

| You are building | Start from |
|---|---|
| A product or object viewer (glTF) | [`samples/model/`](../samples/model/) |
| A three.js object scene with your own loop | [`samples/hello-cube/`](../samples/hello-cube/) |
| A camera you move (a world, a flythrough) | [`samples/camera-rig/`](../samples/camera-rig/) |
| A 2D/3D switch | [`samples/display-modes/`](../samples/display-modes/) |
| A Gaussian splat | [`samples/splat/`](../samples/splat/) |

## 10. Never do

- Use one camera for both eyes, or ignore `views[i]`.
- Push an object back, shrink it or flatten it to "make it comfortable" without seeing a problem on
  a panel.
- Drive convergence from what is under the cursor or the centre of the view; set it to 0.
- Scale one axis of a subject.
- Put pure black behind a bright subject.
- Put HTML over content that comes out of the glass.
- Put `filter`, `backdrop-filter`, `opacity` or a CSS animation on or over the canvas.
- Leave a cover over the canvas that only one signal can remove.
- Raise `ipdFactor` above 1 on a display rig to get "more 3D".

## Where to go next

- [authoring-inline-3d.md](authoring-inline-3d.md) — every API, both rigs in depth, comfort maths.
- [woven-canvas-rules.md](woven-canvas-rules.md) — what the browser does to your canvas.
- [porting-three-js-apps.md](porting-three-js-apps.md) — moving an existing three.js app over.

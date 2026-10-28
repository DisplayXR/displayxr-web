# Making 3D that looks right

**Read this first**, whether you are a person or a coding agent. It is the short path to a page that
looks good on a glasses-free 3D display on the first try. Every rule here comes from pages that
went wrong (double images, flat 3D, stale frames) and from the apps that got it right. The
long-form guides it links to explain the why; this page tells you what to do.

The SDK never stops you from doing anything below. Every number is a recommendation, not a clamp.
If you have a reason to break a rule, break it on purpose and check the result on a panel.

## The 10 rules

1. **Choose the rig by what the user moves.** They turn an object → **display rig**. They move
   through a world → **camera rig**. ([§1](#1-choose-the-rig))
2. **Put the screen plane on the subject.** If there is a clear subject, zero disparity goes
   through it, with about a third of it in front of the glass. No single subject → put the plane
   so about a fifth of the frame is in front. ([§2](#2-put-the-screen-plane-on-the-subject))
3. **Stay inside the depth budget:** about **0.6 % of the tile's width** of disparity in front of
   the glass and **1.5 %** behind, near **0** at the frame edges. ([§3](#3-stay-inside-the-depth-budget))
4. **Nothing in front of the glass touches a frame edge or sits under 2D UI.**
   ([§4](#4-composition-the-cinematic-rules))
5. **Draw each eye with its own view.** Use the SDK's viewers, or `EyeCamera`; never one camera for
   both eyes. Opaque clear, pixel ratio 1. ([§5](#5-draw-each-eye-correctly))
6. **2D UI is HTML at the glass, over content that is at or behind the glass.** No CSS `filter`,
   `backdrop-filter`, `opacity` or animated `transform` on, around or over the 3D canvas.
   ([§6](#6-2d-ui))
7. **One canvas for the whole page; cover it until it is woven; cut, never crossfade.**
   ([§6](#6-2d-ui))
8. **A depth slider moves `ipdFactor` and `parallaxFactor` together.** Never `scale.z`.
   ([§7](#7-depth-slider-and-2d3d-switch))
9. **Offer a 2D/3D switch and work in an ordinary browser.** The page must look right flat, too.
   ([§7](#7-depth-slider-and-2d3d-switch))
10. **Check before you ship:** run the checklist in [§9](#9-checklist-before-you-ship).

## The mental model in six lines

- The page's `<canvas>` is a window onto a 3D scene. The browser draws one image per eye into it
  side by side, and the display **weaves** them so each eye sees its own.
- The **glass** is the zero-disparity plane, `z = 0` in display space. **`+z` comes out of the
  glass toward the viewer; `−z` goes behind it.**
- **Disparity** is how far apart a point lands in the two eyes' images. Too much → **double
  image**. None at all (or the same image twice) → **flat**.
- The glass is the only plane with no crosstalk. The further content is from it, the more the
  panel's ghosting shows, especially on high-contrast edges.
- You declare a **view rig**; the browser and runtime compute the eye views from it. You never
  compute stereo yourself.
- In an ordinary browser the same page runs in 2D (mono): one view, no weave.

## 1. Choose the rig

Decide by **what the user moves**, not by whether your code has a camera.

| The user… | Examples | Rig | Use |
|---|---|---|---|
| turns or inspects **an object** | product viewer, figurine, car configurator, splat of a thing, a tabletop diorama, a chart, a map | **display rig** | `addModel`, `addSplat`, `SceneViewer` (`./viewer`), or `addScene` with `displayRig()` |
| **moves through a world** | first-person walk-through, game, flythrough, editor, ported WebXR/VR | **camera rig** | `addScene` + `EyeCamera` + `cameraRigFromCamera(…, { convergence })` |
| looks at a **captured photo or video** | stereo pair, SBS video, photo splat with a capture camera | the **capture's own rig** | `addImage`, `addPlayer`, `addSplat` (reads the asset's camera block) |

The sharpest test: **if a camera rig would need a scale fudge to look right, you wanted a display
rig.** A display rig scales the subject into a virtual display `virtualDisplayHeight` tall, so the
depth it gets does not depend on how big the subject is in world units. A camera rig plants two
eyes 63 mm apart at your camera; a big subject far from that camera goes flat.

Long form: [authoring-inline-3d.md § Which rig](authoring-inline-3d.md#which-rig--decide-by-what-the-user-moves-not-by-whether-you-hold-a-camera).

## 2. Put the screen plane on the subject

**If there is a clear subject or focus, zero disparity goes on it.** On a display rig that means the
subject sits at `z = 0` in display space (the SDK viewers do this for you). On a camera rig it
means `convergence` = the distance from the camera to the subject.

- Let the subject **straddle** the glass: about a third of its depth in front, two thirds behind.
  The glass is the sharpest plane, so the part the eye lands on should be near it.
- Keep convergence **on the subject** as it moves. Change it smoothly; a jump reads as a cut.
- **No single subject** (a wide shot, a room, a landscape, a photo without a hero)? Use the film
  rule: put the screen plane so **about 20 % of the frame is in front of the glass** and the rest
  behind. Stereographers on native-stereo feature films put zero disparity at roughly the 78th
  percentile of nearness (centre-weighted), measured over 2,121 shots of 19 titles.
- **Never** put everything in front of the glass. On a camera rig, `convergence: 0` (infinity) does
  exactly that: the whole scene floats out. Always set a finite convergence.
- Don't let a big flat background decide the plane. A sky or a far wall is not the subject.

## 3. Stay inside the depth budget

Budgets are **relative**: disparity as a percentage of the tile's width, and, on a display rig,
the equivalent depth in **tile heights** (`h` = the canvas's height on the glass). These hold for
any tile size. They are provisional and come from shipped apps and on-panel measurements. When a
panel disagrees with this table, trust the panel.

| Where | Comfortable (aim here) | Strong (a hero object, briefly) | Never beyond |
|---|---|---|---|
| **In front of the glass**, centre of the frame | **≤ 0.6 %** of width · **0.1 h** | ≤ 1.1 % · 0.18 h, for a moment (≤ 2 s) | 3.3 % · 0.47 h |
| **Behind the glass** | **≤ 1.5 %** · **0.27 h** | ≤ 2.3 % · 0.45 h | 3.3 % · 0.7 h |
| In front, within ~10 % of a **frame edge** or under **2D UI** | **≈ 0** | ≈ 0 | — |
| **Full-frame** scenes (worlds, rooms, edge-to-edge photos), in front | **≤ 0.3 %** · 0.05 h | ≤ 0.6 % | — |
| Full-frame, behind (including the far background) | **≤ 1.0 %** · 0.18 h | ≤ 1.5 % | — |

Read it like this:

- **Behind is cheaper than in front.** Pop-out is the effect people notice, and also the one that
  breaks first. Spend it on the subject, not on the whole scene.
- **The "never beyond" column is the human limit**, the zone of comfort around the glass (about
  ±0.3 dioptre of vergence–focus mismatch, Percival's zone at a 0.6 m viewing distance). It is
  necessary, not sufficient: the panel's crosstalk makes double images far sooner, which is why
  the comfortable column is 3–5× tighter.
- **Infinity is not free.** On a camera rig, a background at infinity has the largest disparity in
  the scene (the formula below with `1/z = 0`), and it can exceed every row above. Fog it, bring it
  in, or lower `ipdFactor`.
- **High-contrast, sharp edges ghost first.** A white edge on black at 1 % reads worse than a soft
  mid-grey one at 2 %.

### Converting to your scene

On a **display rig** the subject's depth in tile heights is direct: the viewers fit the subject's
**height** to `margin` of the tile (0.8 by default), so a subject as deep as it is tall spans about
±0.4 h, which is the **strong** column, not the comfortable one. For a calm default, fit by depth
too: scale so the subject's depth is at most ~0.4 h, with ~0.1 h of it in front. In the SDK
viewers, read the live placement with `getSubjectBounds()` (`front`/`back` in display metres;
divide by `virtualDisplayHeight` for tile heights).

On a **camera rig**, a point `z` world units from the camera, with convergence `D`, lands at

    disparity (% of width) ≈ 100 × b × (1/D − 1/z) / (2 × tan(verticalFov / 2) × aspect)
    b = 0.063 × ipdFactor × metersToVirtual        (eye separation, world units)

positive behind the glass (`z > D`), negative in front. The farthest point you can see, often
the background at `1/z = 0`, sets the "behind" number; the nearest sets "in front". In practice: set `convergence` on the
subject, then lower `ipdFactor` until the nearest and the farthest things you can see sit inside
the table.

## 4. Composition: the cinematic rules

1. **Nothing in front of the glass touches a frame edge.** An edge cutting through pop-out content
   (a "window violation") breaks the illusion at once: the edge is at the glass, the content is in
   front of it, and the brain cannot reconcile them. Keep pop-out content in the central region;
   let anything that crosses an edge sit at or behind the glass.
2. **Nothing in front of the glass sits under HTML.** A button "behind" content that comes out at
   you is the same conflict. Either move the UI to where the picture is behind the glass, or draw
   the label inside the 3D scene above the content.
3. **Before placing chrome, make a depth map of the screen:** where the content is behind the
   glass (2D-safe), at the glass, and in front (3D airspace). UI goes only in the first.
4. **Move depth slowly.** Convergence and depth-strength changes follow the subject over a second
   or more, critically damped. A hard cut is fine; a fast drift is not.
5. **Keep the eye separation fixed** in a continuous shot. A baseline that adapts to the scene reads
   as the world breathing. Adjust it on a cut or on the user's request.
6. **Avoid sharp, high-contrast silhouettes off the glass.** Match the page colour behind the canvas
   to the subject, soften glints and fine normal maps, and keep thin text at the glass.
7. **A frame hitch reads as "tracking froze".** Warm shaders before first use (`warmEntity`,
   `warmEffect`), slice heavy work, and never freeze the image under a tracked head.

## 5. Draw each eye correctly

**Prefer the SDK's own viewers** (`addModel`, `addSplat`, `addImage`, `addPlayer`, `SceneViewer`):
they render each eye correctly and handle the mono fallback. Write your own loop only when you need
to, and then follow [the starter template](../samples/starter-scene/) exactly:

- Draw **every view** with **its own** `projectionMatrix` and `transform`, into **its own**
  `layer.getViewport(view)`. In three.js use `EyeCamera`. Using your own camera for both eyes gives
  the same image twice, which looks flat.
- **Check the views before clearing**: if a frame has fewer views than you expect, keep the last
  good frame on screen instead of clearing or skipping.
- **Clear opaque.** A transparent clear shows stale or black pixels on the weave. Give the scene a
  background colour, and set the page colour behind the canvas to match it.
- **Pixel ratio 1** on the renderer: the SDK sizes the canvas; don't multiply it again.
- Size the canvas **before** you register it, and resize only in the SDK's `onResize`.
- Give the session your camera's near and far planes once it is up:
  `wall.session.updateRenderState({ depthNear: camera.near, depthFar: camera.far })`. Each eye's
  projection is built from them.

## 6. 2D UI

- **Text and controls are HTML, at the glass.** That keeps them crisp. Put them where the picture is
  at or behind the glass ([§4](#4-composition-the-cinematic-rules)).
- **No render-surface CSS on, around or over the canvas:** no `filter` (including on hover), no
  `backdrop-filter`, no `opacity` below 1, no `mix-blend-mode`, no animated `transform`, on the
  canvas, any ancestor, or anything drawn over it. Any of these takes the canvas out of the weave
  and it goes flat. A plain translucent `rgba()` background on UI is fine; a blur is not.
- **One canvas for the whole page.** Don't remount or recreate it between screens; change what is in
  it.
- **Cover the canvas until it is woven.** Keep a cover over it until `handle.firstWoven` resolves
  (and again around a resize, until `handle.rewoven()`), then remove the cover in one step. Never
  fade the cover.
- **Cut between scenes, don't crossfade two canvases.** Crossfade inside one canvas if you need to.
- **Hard-cut small labels** that track 3D points; don't fade them.
- If DOM sits over the canvas and you use the depth cursor (`cursor: 'depth'`), set
  `pointerScope: 'window'`.

Long form: [woven-canvas-rules.md](woven-canvas-rules.md).

## 7. Depth slider and 2D/3D switch

**Depth slider.** Map one slider value `k` in `[0, 1]` (default 1) to **both** `ipdFactor` and
`parallaxFactor`, so the look-around shrinks with the depth:

```js
// display rig (addScene / SceneViewer)
handle.setViewRig(displayRig({ virtualDisplayHeight: 0.24, ipdFactor: k, parallaxFactor: k }));
// addSplat handle
splat.setStereo({ ipdFactor: k, parallaxFactor: k });
```

On a display rig these factors are relative (`1` = what the display does naturally), so a slider
from 0 to 1 is a comfort dial: it can only make the scene shallower. To make a scene **deeper** than
that, give it more depth (move the subject's ends further from the glass, within §3), not a bigger
factor. On a camera rig the factors are absolute; keep the slider's top at your tuned value.

Never implement a depth slider by scaling the scene's `z`: on anything rotated it shears the
geometry. Splitting the two factors (stereo without look-around, or the reverse) is legitimate when
you want that effect; make it a deliberate choice.

**2D/3D switch.** `handle.setStereoEnabled(false)` asks the display for its flat mode and collapses
the eyes; `true` returns to 3D. It rejects where the display lists no such mode (and changes
nothing), so catch it and fall back: setting the depth slider to 0 gives a flat image on any
display. Show the real state from the `renderingmodechange` event, not from the button.

**The ordinary browser.** `createInline3D()` resolves `{ supported: false }` in a browser without
the 3D API. The SDK viewers then render a normal 2D view on their own; with `addScene`, draw one
view with a normal camera. The page must look finished in 2D: same layout, same UI.

## 8. Templates

Each starter is a complete page that follows every rule above. Copy the one that matches your case
and change the content, not the plumbing.

| You are building | Start from |
|---|---|
| A product or object viewer (glTF) | [`samples/starter-model/`](../samples/starter-model/) |
| A three.js object scene: diorama, chart, animated set piece | [`samples/starter-scene/`](../samples/starter-scene/) |
| A first-person world: walk-through, game, flythrough | [`samples/starter-world/`](../samples/starter-world/) |
| UI over 3D, with a depth slider and a 2D/3D switch | [`samples/starter-ui/`](../samples/starter-ui/) |
| A Gaussian splat | [`samples/splat/`](../samples/splat/) |

## 9. Checklist before you ship

On a laptop, no 3D display needed:

- [ ] Rig chosen by the §1 table, and written down in a comment.
- [ ] Screen plane on the subject (or the ~20 %-in-front rule), and on a camera rig a **finite**
      `convergence`.
- [ ] The scene's nearest and farthest visible points inside the §3 table, with your numbers in a
      comment next to the settings.
- [ ] Nothing in front of the glass within ~10 % of a frame edge or under HTML.
- [ ] Each eye drawn with its own view; opaque clear; pixel ratio 1; last good frame kept on short
      view lists.
- [ ] No `filter`, `backdrop-filter`, `opacity < 1`, `mix-blend-mode` or animated `transform` on the
      canvas, its ancestors or anything over it.
- [ ] One canvas for the page, covered until `firstWoven`; hard cuts.
- [ ] Depth slider moves `ipdFactor` and `parallaxFactor` together; 2D/3D switch with a fallback.
- [ ] Opens in an ordinary browser with no errors and looks finished in 2D.

On a 3D display:

- [ ] No double image on the nearest and farthest content, at the default slider position.
- [ ] Nothing ghosts at the frame edges; UI is crisp; text is readable at arm's length.
- [ ] No flash of a squeezed side-by-side image on load, resize or navigation.

## 10. Never do

- Use one camera for both eyes, or ignore `views[i]`.
- Set a camera rig's `convergence` to 0, or leave it unset, and hope.
- Fit depth with `scale.z` (or any per-axis scale) on a rotated subject.
- Put HTML over content that comes out of the glass.
- Put `filter`, `backdrop-filter`, `opacity` or a CSS animation on or over the canvas.
- Clear to transparent, or skip a frame by clearing it.
- Recreate the canvas between screens, or crossfade two 3D canvases.
- Raise `ipdFactor` above 1 on a display rig to get "more 3D".

## Where to go next

- [authoring-inline-3d.md](authoring-inline-3d.md) — every API, both rigs in depth, comfort maths.
- [woven-canvas-rules.md](woven-canvas-rules.md) — what the browser does to your canvas, and why the
  CSS and remount rules exist.
- [porting-three-js-apps.md](porting-three-js-apps.md) — moving an existing three.js app over.
- [authoring-motion-and-effects.md](authoring-motion-and-effects.md), [splat-effects.md](splat-effects.md)
  — motion, reveals, depth envelopes.

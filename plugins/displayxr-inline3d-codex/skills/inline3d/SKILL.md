---
name: inline3d
description: Build or fix web pages that show 3D on Spatial Displays with @displayxr/inline3d (the DisplayXR Browser weaves a canvas; any other browser shows 2D). Use whenever code imports @displayxr/inline3d, calls createInline3D / addImage / addVideo / addScene / addPlayer / addModel / addSplat, or the user asks for a 3D web page, 3D photo/video/model/splat viewer, or "inline 3D" for a spatial display. Covers the content type and entry point, the view rig, depth/comfort, the woven-canvas rules, page chrome, exact version pins, and running the checker (`@displayxr/inline3d-tools`, an exact-pinned npm package) before saying done.
---

# Building on @displayxr/inline3d

A woven window is a `<canvas>` whose **buffer holds two eyes side by side** while its CSS box is the
shape the viewer sees. The DisplayXR Browser weaves it; every other browser shows the page in 2D.
The installed package is the source of truth: read `node_modules/@displayxr/inline3d/llms.txt` first,
then the docs below **from `node_modules/@displayxr/inline3d/`** (they match the installed version;
this skill does not copy them). The `.d.ts` files there carry the full API with JSDoc.

## 1. Pick the content type and entry point

| You have | Call | Notes |
|---|---|---|
| a side-by-side 3D photo | `wall.addImage(canvas, 'pic_2x1.jpg')` | SDK sizes the buffer; style only the box |
| an SBS 3D video element | `wall.addVideo(canvas, videoEl)` | VP9/WebM plays everywhere; `.mp4` may not |
| a video with transport UI | `addPlayer(wall, canvas, src, opts)` from `/player` | canvas must sit in a container; `format: 'mono'` for 2D titles |
| a glTF/GLB model | `addModel(wall, canvas, url, opts)` from `/model` | PlayCanvas by default; `engine: 'three'` for three.js; Draco/KTX2 decoders are files YOU serve |
| a Gaussian splat (.sog/.ply) | `addSplat(wall, canvas, src, { engine: 'playcanvas' })` from `/splat/playcanvas` | the page behind the tile shows around the splat (§4: keep it soft, or pass an opaque `clearColor`); Spark (three) is the `/splat` default; PlayCanvas adds `setSource`, effects, streaming |
| your own three.js / WebGL scene | `wall.addScene(canvas, onFrame, opts)` + `EyeCamera` from `/three` | you render each eye into `layer.getViewport(view)` |

`addModel` / `addSplat` / `addPlayer` take the wall and work with an unsupported one (they draw the
2D fallback themselves). Prefer them over a hand-written scene whenever the content fits: they size
the buffer, clamp it to the device, frame the subject on the glass, and validate frames.
three or PlayCanvas: use PlayCanvas for models and splats (the default, the most tested path); use
three when the page already is a three.js app (`addScene` + `EyeCamera`, see
`docs/porting-three-js-apps.md`).

## 2. Pick the rig by what the user moves

- The user turns a **subject** (model, product, diorama, chart, avatar), even with an orbit control:
  **display rig** (the default). Keep an existing orbit camera and pose the portal from it:
  `displayRig({ position: target, orientation: camera.quaternion, virtualDisplayHeight: 2*d*tan(fov/2) })`.
- The user moves **through a world** (first person, game, map, walkthrough, ported VR): **camera rig**,
  `cameraRigFromCamera(THREE, cam, { convergence })`, set per frame with `handle.setViewRig`.
  A game is a world even when it is seen from above (an RTS, a board, a top-down map the user pans
  and zooms): the camera moves, so it is a camera rig. Tie `convergence` to the ground at the view
  centre (raycast the centre of the screen to the ground plane), not to the cursor or a gaze point,
  and cap zoom-in so the comfort product stays ≤ 1.
- **Use most of the comfort zone: too little depth is a failure too** (near-zero disparity reads
  flat). Camera-rig eyes are real eyes, `0.063 m × ipdFactor × metersToVirtual` apart (world units
  per real metre). Rule:
  1. `convergence` = camera to centre of interest; the subject straddles the glass.
  2. Never rescale your world; set `metersToVirtual`: true scale (metres, cm, ported VR) → the true
     conversion (1, 100); no true scale (most games) → `convergence / 2` in your units (subject at
     2 m; 13.4 → 6.7). If zoom changes the distance a lot, re-set it per frame in `setViewRig`.
  3. `ipdFactor` tunes depth: ≈ 1 for an open scene (to the horizon); bounded (board, room, track):
     0.8–1× of `cameraRigComfortFactor({ zNear, zFar, convergence, verticalFov, aspect, tileHeightM,
     viewerM, ipdFactor, metersToVirtual })` (`@displayxr/inline3d/depth`; fills the zone; often 1.5–2.5).
  `parallaxFactor` = `ipdFactor`; perspective, tilted camera; never `convergence: 0`. Comfort
  `ipdFactor × metersToVirtual × convergenceDiopters × N` ≤ 1 (N = `nominalViewerPosition.z`, else
  0.6 m) is the ceiling for content at infinity, not a target. Example: 13.4 units out, `ipdFactor: 2.5`, `metersToVirtual: 1`
  uses ~20% of the zone, flat; rule: `metersToVirtual: 6.7`, `ipdFactor` ≈ 1.4–1.7.
- **Display rig:** `ipdFactor`/`parallaxFactor` 1 = natural, full roundness; don't lower without a reason.
- Budgets are reports, not limits to stay far inside: never lower depth as the user zooms.
  Details: `docs/authoring-inline-3d.md` § Aim for real depth.

## 3. Depth and comfort (`docs/making-3d-look-right.md`, ten rules)

The subject straddles the glass (z = 0): about a quarter in front, the rest just behind, at real
proportions; don't push it back, shrink it or flatten it. `addModel` does this by default (SDK
1.57.0+): screen plane at the surface's 75th-percentile depth toward the viewer, pivot at the surface's
median, fit from trimmed extents, so a thin tail or antenna moves neither size nor depth; keep that
placement (`framing: 'box'` restores the old bounding-box centring, only for a reason you can name).
`addSplat` and `SceneViewer.fitTo(center, extent)` centre the subject's robust centre on the glass; a
scene you build yourself follows the same rule.
`+z` is OUT of the glass. Frame the whole subject in the first view. Tilt flat layouts 25–40° about an
axis through the glass. Keep moving things' forward swing small. Worlds: fixed convergence, keep the
camera clear of near geometry. Light/mid-tone low-contrast backgrounds (never pure black behind a
bright subject). **A backdrop sits behind the subject, never on the glass** (rule 10): a CSS image
behind a transparent canvas is on the glass and conflicts with any part of the subject behind it.
Draw a photo backdrop in the scene as ONE unlit plane fixed to the display, NOT to the subject (it
does not turn with the orbit or grow with the zoom; never parent it to the model. PlayCanvas: a child of
`handle.viewer.rigNode`; +z toward the viewer, one tile height = `viewer.vH`), behind the subject's
farthest point at any turn and the largest zoom you allow (cap the zoom so this holds), at about 40% of the rear comfort budget:
`backdropPlacement({ backH, tileHeightM })` from `@displayxr/inline3d/depth` returns its depth
(`depthH`) and size (`widthH` × `heightH`), tile heights. Pre-blurred, mid-tone; no skybox or
environment map as a backdrop. A plain colour or soft gradient needs none of this.
Text as HTML near the glass, not in the scene. No coplanar faces (z-fighting), no
sub-pixel detail. Scene units: metres for a `virtualDisplayHeight` (0.24 by default); never scale the
world per frame. Shrinking depth: rotate or scale uniformly, never squash z.

## 4. Woven-canvas checklist (`docs/woven-canvas-rules.md`)

- [ ] **One** `createInline3D()` per document (or `sharedInline3D()`); `close()` on `pagehide`.
- [ ] **One persistent canvas**; never remount it on state change (React keys, Strict Mode). Swap
      content inside it (`setSource`, redraw the source, change the scene). `add*()` twice on a canvas
      is not a swap: `remove()` first.
- [ ] **No CSS effects on the canvas or any ancestor**: `filter`, `opacity < 1`, `mask`, `clip-path`,
      `mix-blend-mode`, `backdrop-filter`, scale/rotate transforms. No `border`, `border-radius`,
      `box-shadow` on the canvas (use `cornerRadius` / `feather`). Never animate the tile's box.
- [ ] **Cover a new canvas** with an opaque element on top until `await handle.firstWoven`, then remove
      it with a hard cut, and ALSO on a timeout (~4 s) and in `catch`, so it always comes off. A
      `firstWoven` with `woven: false` still means "drop the cover and keep drawing both eyes".
      **Video and players too:** `loadeddata`, `canplay`, a player's `'ready'` and the first decoded
      frame all fire BEFORE the join, so a cover released there shows the raw pair for up to ~1.2 s.
      Release on `handle.firstWoven` (`addVideo`), `player.firstWoven` (`addPlayer`, SDK 1.53+; on an
      older SDK where it is undefined, wait for the first frame and then `firstWovenHoldMs` ≈ 1200 ms
      more), plus the timeout. Give a player a `poster`: it is painted into both eyes under the cover.
- [ ] **Covering a move or resize:** use `rectCover: 'auto'` (the default on `./splat` / `./model`).
      Running your own cover (`rectCover: 'off'`): raise it only while `handle.wovenState` is not
      `'woven'`, and release it on `handle.rewoven()`. A cover over a tile the browser is still weaving
      is woven with it: each eye gets half of its 2D picture, stretched twice as wide (SDK 1.56.1+;
      `woven-canvas-rules.md` §11).
- [ ] **What is behind a transparent tile is part of the picture.** `addSplat` / `addModel` clear
      transparent by default, and the browser pre-blends the page under both eyes, flat, at half
      horizontal resolution, on the glass. Make that page area a soft light or mid-tone colour or gradient (no
      text or photo behind a tile, never black behind a bright subject; a photo backdrop goes IN the
      scene, behind the subject: §3, rule 10), or pass an opaque
      `clearColor: [r, g, b, 1]` (0..1).
- [ ] **`onLayerLost` goes flat** (`addScene` pages): pass `onLayerLost` and, in it, render ONE mono
      camera across the whole canvas on your own rAF loop (the `!wall.supported` path) or show a 2D
      fallback. An empty `() => {}` leaves the last side-by-side pair on screen, unwoven. `SceneViewer`:
      `onLayerLost: viewer.onLayerLost`; `addSplat` / `addModel` / `addPlayer` handle it themselves.
- [ ] **Nothing opaque above the canvas**; backgrounds and black go *under* it. Never overlap two
      woven canvases (hide the lower one with `display: none`).
- [ ] **Buffer = 2 × eye width, from `sceneBufferSize`** (core, 1.58.0+): an `addScene` page sizes its
      canvas with `sceneBufferSize(canvas, { sbs, viewScale: sbs ? await handle.getDisplayInfo() : null })` (set
      `canvas.width/height`, or `renderer.setSize(s.width, s.height, false)`, only when they change;
      camera aspect from `s.eyeWidth / s.eyeHeight`), never `clientWidth × devicePixelRatio × 2`. Per eye
      it is window device px × the runtime's view scale (dpr ≤ 2 without one), fitted to the GL limits
      and the browser's drawing-buffer area cap. Hand-rolled on an 8K panel at 300% it asks for
      15360×4320; the browser silently shrinks the buffer, the eyes land off-centre and one eye shows
      both images. The SDK's `the browser clamped this canvas's drawing buffer` warning is that bug.
      Draw into `gl.drawingBufferWidth/Height`. three.js:
      `renderer.setPixelRatio(1)` when you use `getViewport()`.
- [ ] **Validate before you clear**: skip the clear when `views.length < 2` or a viewport is `null`;
      repaint the last good frame. Copy `XRViewport` / `XRView` fields by name (their fields are
      getters: spread and `Object.assign` copy nothing). Redraw every frame.
- [ ] **Never draw one full-width flat picture into a woven canvas.** To show 2D on purpose, call
      `wall.setStereoEnabled(false)` (fall back to easing `ipdFactor` to 0 on `NotSupportedError`).
- [ ] **2D fallback**: on `!wall.supported` render one mono view or show an `<img>` (the left eye),
      never the packed side-by-side pair. `createInline3D()` and the startup around it can also
      **reject** (an unexpected error, no WebGL, a failed import or asset). Guard it, log the reason:
      `const wall = await createInline3D().catch((err) => { console.warn('inline 3D unavailable, showing 2D', err); return null; });`
      (or wrap the whole startup in `start().catch(...)`, as the scaffold's `app.js` does), then
      treat `null` like `!wall.supported`: draw the 2D view, or show a visible error, and drop the
      cover. An unhandled rejection leaves a blank or still-covered canvas: no 3D and no 2D.

## 5. Page chrome, HUD and detection

- Detect by capability: `await createInline3D()` → `wall.supported`, or `inline3DAvailable()` as a sync
  pre-gate. **Never** the user-agent string, never `navigator.xr.isSessionSupported('inline-3d')`.
- Current browsers occlude woven tiles with 2D by draw order: a sticky header the tile scrolls
  under, a buy card in a corner, badges, menus and captions over a tile just work, **opaque or
  translucent**, as plain HTML (a solid or rgba background and text). Keep them **partial** (a bar,
  a card, a pill): a section painted over the WHOLE tile hides it while it keeps rendering.
- What does NOT work over a tile: a pixel-moving `filter` (blur, drop-shadow), a `mix-blend-mode`
  other than normal, `transform-style: preserve-3d` on the chrome; the tile weaves through them.
  `backdrop-filter` (frost) is fine on DisplayXR Browser 0.1.16+ over a **partial** region (the tile
  is drawn flat under it), never over a whole visible tile. If you must also serve older browsers,
  use a near-solid `rgba(…, .92)` bar without blur.
- Hide chrome with `display: none`, not `opacity: 0`. Ask `inline3dOcclusionByDrawOrder()` only to
  drop legacy calls. The checker scrolls the page and reports chrome that passes over a tile.
- HUD text and values: HTML beside or over the tile, readable size, not drawn into the 3D scene.

## 6. Pins (exact versions, no `^`)

`@displayxr/inline3d` **1.58.0**, `playcanvas` **2.24.0** (exact; `>=2.22.3 <3` is the supported
range), `three` **0.180.0**. CDN import maps pin the same: `https://cdn.jsdelivr.net/npm/@displayxr/inline3d@1.58.0/js/inline3d.js`,
`https://cdn.jsdelivr.net/npm/playcanvas@2.24.0/build/playcanvas.mjs`,
`https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js`. If a newer SDK is installed, its
`CHANGELOG.md` says what changed; prefer the installed version's docs over this list.

## 7. Before you say done: run the checker

```sh
npx -y @displayxr/inline3d-tools@0.1.5 check <url | dir | page.html> [--root <project>] [--max-texture 4096]
```

This runs the exact-pinned `@displayxr/inline3d-tools` package from npm (the first run downloads it;
the user approves the command). Needs Node ≥ 18 and a local Chrome (`CHROME=/path/to/chrome`).
If the `inline3d-tools` MCP server is configured, its `check` tool is the same check (and the route
to use inside a sandbox that blocks local servers).
It loads the page in headless Chrome inside a fake DisplayXR Browser (two real eye views) and again
plain, and reports pass/fail per check: session reached, real stereo, no blank eye, no flat
side-by-side, buffer not clamped, CSS/cover/overlay/session rules (scrolling the page past each
tile), the page going flat when the session ends (`onLayerLost`), console and GL errors, 2D
fallback, plus the rig, comfort and measured depth. Fix every **FAIL**; read every **WARN**; each
line names the doc section. For a Vite/dev-server app pass the running URL. Use `--root <project>`
when a page imports `../` or `/node_modules/`. A green run is not a panel test: say so, and ask for
a check on real hardware when depth or look matters. Scaffold a known-good page with the
`new-inline3d-page` skill. Any model, texture or poster the page loads goes through the
`inline3d-assets` skill first (convert, optimise, `assets` check, `ASSETS.md`).

**When to run it.** After you edit any file of a page that uses `@displayxr/inline3d` (its HTML,
scripts or CSS), the page is unchecked until the checker has run again: run it before you tell the
user the page is done, and again after every round of fixes. If you end a turn with an edited page
you could not check (no Chrome, no Node, the user declined the command), say so in one line and give
the user the command above to run.

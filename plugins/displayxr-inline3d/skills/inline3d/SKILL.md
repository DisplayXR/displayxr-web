---
name: inline3d
description: Build or fix web pages that show glasses-free 3D with @displayxr/inline3d (the DisplayXR Browser weaves a canvas; any other browser shows 2D). Use whenever code imports @displayxr/inline3d, calls createInline3D / addImage / addVideo / addScene / addPlayer / addModel / addSplat, or the user asks for a 3D web page, 3D photo/video/model/splat viewer, or "inline 3D" for a spatial display. Covers the content type and entry point, the view rig, depth/comfort, the woven-canvas rules, page chrome, exact version pins, and running the bundled checker before saying done.
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
| a Gaussian splat (.sog/.ply) | `addSplat(wall, canvas, src, { engine: 'playcanvas' })` from `/splat/playcanvas` | Spark (three) is the `/splat` default; PlayCanvas adds `setSource`, effects, streaming |
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
- Details: `docs/authoring-inline-3d.md` § View rigs. Comfort on a camera rig:
  `ipdFactor × metersToVirtual × convergenceDiopters × ~0.6` must stay ≤ 1; never `convergence: 0`.

## 3. Depth and comfort (`docs/making-3d-look-right.md`, nine rules)

Centre the subject on z = 0 (the glass), at real proportions; don't push it back or flatten it.
`+z` is OUT of the glass. Frame the whole subject in the first view. Tilt flat layouts 25–40° about an
axis through the glass. Keep moving things' forward swing small. Worlds: fixed convergence, keep the
camera clear of near geometry. Light/mid-tone low-contrast backgrounds (never pure black behind a
bright subject). Text as HTML near the glass, not in the scene. No coplanar faces (z-fighting), no
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
- [ ] **Nothing opaque above the canvas**; backgrounds and black go *under* it. Never overlap two
      woven canvases (hide the lower one with `display: none`).
- [ ] **Buffer = 2 × eye width**: `addScene` pages size it themselves (2× the box aspect, devicePixelRatio
      ≤ 2, every side ≤ 4096 for tablets) and draw into `gl.drawingBufferWidth/Height`. three.js:
      `renderer.setPixelRatio(1)` when you use `getViewport()`.
- [ ] **Validate before you clear**: skip the clear when `views.length < 2` or a viewport is `null`;
      repaint the last good frame. Copy `XRViewport` / `XRView` fields by name (their fields are
      getters: spread and `Object.assign` copy nothing). Redraw every frame.
- [ ] **Never draw one full-width flat picture into a woven canvas.** To show 2D on purpose, call
      `wall.setStereoEnabled(false)` (fall back to easing `ipdFactor` to 0 on `NotSupportedError`).
- [ ] **2D fallback**: on `!wall.supported` render one mono view or show an `<img>` (the left eye),
      never the packed side-by-side pair.

## 5. Page chrome, HUD and detection

- Detect by capability: `await createInline3D()` → `wall.supported`, or `inline3DAvailable()` as a sync
  pre-gate. **Never** the user-agent string, never `navigator.xr.isSessionSupported('inline-3d')`.
- Current browsers occlude woven tiles with 2D by draw order: headers, badges, menus and captions
  over a tile just work. Keep them **partial** (a bar, a pill), never a full-tile plate. Frost
  (`backdrop-filter`) only a partial region, never a whole visible tile. Hide chrome with
  `display: none`, not `opacity: 0`. Ask `inline3dOcclusionByDrawOrder()` only to drop legacy calls.
- HUD text and values: HTML beside or over the tile, readable size, not drawn into the 3D scene.

## 6. Pins (exact versions, no `^`)

`@displayxr/inline3d` **1.52.3**, `playcanvas` **2.24.0** (exact; `>=2.22.3 <3` is the supported
range), `three` **0.180.0**. CDN import maps pin the same: `https://cdn.jsdelivr.net/npm/@displayxr/inline3d@1.52.3/js/inline3d.js`,
`https://cdn.jsdelivr.net/npm/playcanvas@2.24.0/build/playcanvas.mjs`,
`https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js`. If a newer SDK is installed, its
`CHANGELOG.md` says what changed; prefer the installed version's docs over this list.

## 7. Before you say done: run the checker

```sh
node "${CLAUDE_PLUGIN_ROOT}/checker/bin/inline3d-check.mjs" <url | dir | page.html> [--root <project>] [--max-texture 4096]
```

It loads the page in headless Chrome inside a fake DisplayXR Browser (two real eye views) and again
plain, and reports pass/fail per check: session reached, real stereo, no blank eye, no flat
side-by-side, buffer not clamped, CSS/cover/overlay/session rules, console and GL errors, 2D
fallback, plus the rig, comfort and measured depth. Fix every **FAIL**; read every **WARN**; each
line names the doc section. For a Vite/dev-server app pass the running URL. Use `--root <project>`
when a page imports `../` or `/node_modules/`. A green run is not a panel test: say so, and ask for
a check on real hardware when depth or look matters. Scaffold a known-good page with the
`new-inline3d-page` skill.

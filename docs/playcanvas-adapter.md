# The PlayCanvas splat backend (`engine: 'playcanvas'`)

Status: **preview** (the `./splat` tier — see [sdk-stability.md](sdk-stability.md)). Epic
[#36](https://github.com/DisplayXR/displayxr-web/issues/36), phase P1. The design and the P0
spike that justified it are in `docs/playcanvas-backend.md` (PR #37).

```js
import { addSplat } from '@displayxr/inline3d/splat';
const h = addSplat(wall, canvas, bytesOrUrl, { engine: 'playcanvas' });   // same handle as Spark
```

- **Opt-in only.** No `engine` (or `engine: 'spark'`) is the three + Spark path, unchanged. A page
  that never asks never resolves `playcanvas`: `./splat` imports the adapter with a literal dynamic
  `import('./inline3d-splat-playcanvas.js')`, and the adapter imports the engine the same way.
- **Peer:** `playcanvas >=2.22.3 <3`, optional. Or hand the module in: `{ playcanvas: pc }`.
- **Formats:** `.sog` (bytes or URL), `.ply`, and a Streamed SOG by URL: its `lod-meta.json`, or
  the directory holding it (a URL ending in `/`). Bytes of a `lod-meta.json` throw at call time
  (a Streamed SOG is a directory of relatively named chunks; §Streamed SOG). `.spz`,
  `.splat` and `.ksplat` are Spark-only: with `engine: 'playcanvas'`, `addSplat` **throws at call
  time** when it can tell (a URL extension, gzip bytes, a Spark-only `fileType`).
- **Extra options:** `preserveDrawingBuffer` (default false; the weave's zero-copy read race on
  large canvases, browser-pvt#24), `orbitMaxDeg` / `orbitEase`, `zoom` (§Zoom bounds and relax), and `captureFit` (both backends).
- **Extra handle members:** `setSource(src, { fadeMs, resetPose, transition, reveal })` (it throws
  on Spark), `setRig` / `setVideo` (§setRig, §setVideo), `engine` → `{ app, root, camera }`, and the splat effects — `reveal`, `playEffect`,
  `setEffect`, `stopEffect`, `effects()` ([`splat-effects.md`](splat-effects.md)).
- **Third-party notices:** the engine is MIT; shader code adapted from it (the footprint fix, the
  quad-extent cap, the dissolve effect) is listed in [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

## How it is built

One `AppBase` per tile on our own WebGL2 device (`xrCompatible: false`, no `XrManager`, no
mouse/keyboard/touch). One camera renders every view: its `camera.xrViews` is a list of
`RenderView`s, one per runtime view, with the view's projection, pose and pixel viewport, which is
the engine's own WebXR stereo path driven without WebXR. That means one gsplat manager, one sort
and one work buffer per frame for all eyes. The engine's `requestAnimationFrame` is a no-op, and
`app.tick()` runs from the wall's frame callback in 3D and from the SDK's own rAF in mono.

The subject does not move; the eyes do. The camera's parent node carries the **inverse** of the
same pivot SceneViewer puts on the content (orbit centre, pitch·yaw, fit × zoom, −focus).
`RenderView` composes the parent into every view, so the picture is identical: view × model is
the same product. This module's tick is the only writer of that node, which keeps the 1.7
ownership rule.

Two engine shader chunks are rewritten after `app.init`, each behind a whitespace-agnostic regex
anchor that warns once and renders unpatched if the engine moves the line:

1. **`gsplatCornerVS` footprint fix** (always on). The engine derives one focal length from the
   viewport *width* and uses it for both axes. A side-by-side eye is half-width over a full-height
   frustum, so without the fix every splat is drawn at half height. The fix uses
   `viewport_size.y · P[1][1]` for y. It is a no-op on square pixels. Upstream: P4d.
2. **`gsplatCommonVS` quad extent** (only when a `perf` preset shrinks the quad). This is Spark's
   `maxStdDev`.

## `handle.engine` — adding your own content

`handle.engine` is `{ app, root, camera }`: the tile's `pc.AppBase`, the content root entity
(the splat's content space; add your entities under it), and the eye-rig camera entity.
`remove()` destroys the app and everything under `root` with it. This is advanced and not
covered by the semver promise.

**What the app registers (1.9.1).**
- Component systems: `Camera` and `GSplat` for the splat, plus `Render`, `Light` and `Anim`.
- Resource handlers: `Texture` and `GSplat`, plus `Container` (`.glb` / `.gltf`).

That is exactly what a glTF needs, skinned and animated included, and nothing more from the
engine's full `Application` list. Physics, UI, audio, particles and scripts remain the page's to
add. The container's sub-assets (render, material, animation) arrive already loaded, so they need
no handlers of their own (verified by running a skinned, animated `.glb`).

Pages written before 1.9.1 registered those systems themselves. The engine throws on a duplicate
system id, so the adapter makes a second `app.systems.add()` of a registered id a no-op that
returns the existing system. Re-adding a handler is harmless in the engine anyway.

**Cost**, measured:
- Bundle, esbuild 0.28.2 minified, for a tree-shaken minimal viewer: **+152 KB min / +41.8 KB
  gzip** (1,346,588 → 1,498,900 bytes; gzip 354,215 → 396,009).
- For the SDK as shipped, the bundle cost is none. Since 1.12 the adapter reaches the engine
  through `js/inline3d-playcanvas-engine.js` (named re-exports), which bundlers tree-shake: the
  engine chunk went from 2,434,536 bytes / 626 KB gzip (the namespace of `import('playcanvas')`)
  to 1,499,851 / 397 KB. An importmap still loads the whole engine file.
- Boot: `AppBase.init` median **0.4 → 0.5 ms** (+0.1 ms), in headless Chrome 153 on M1 Pro, 20
  interleaved runs each.

That is well under the 5 ms threshold, so registration is **eager**: `handle.engine.root` is
usable as soon as `ready` resolves.

```js
const { app, root } = handle.engine;
const a = new pc.Asset('fox', 'container', { url: 'fox.glb' });
app.assets.add(a); app.assets.load(a);
a.ready(() => {
  const e = a.resource.instantiateRenderEntity();
  root.addChild(e);                       // content space, same as handle.frame
  e.addComponent('anim', { activate: true });
  const track = a.resource.animations[0].resource;
  e.anim.assignAnimation(track.name, track);   // the TRACK's name — see below
});
```

**Two engine gotchas** hit in the field:
- **A light shines along its local −Y**, while `lookAt` aims an entity's −Z. A light pointed with
  `lookAt` lights the wrong way. Rotate it (for example `setLocalEulerAngles(45, 30, 0)`), or
  `lookAt` and then pitch it by −90°.
- **Container sub-assets are named `<asset name>/animation/N`.** When the asset name has a dot
  (`fox.glb`), passing that string to `assignAnimation` makes the anim component read the dot as
  a path separator. Measured here, the animation silently never plays (no base layer is
  created). The field page instead threw `t.getChild is not a function`. Either way, use the
  track's own name: `track.name`.

**Depth.** Meshes depth-test against each other, and splats test against the meshes; splats don't
write depth. Verified: a skinned fox placed behind the photo's foreground loses 741 of 7,014
pixels to nearer splats, and 0 when placed in front.

The adapter owns the projections: runtime views in 3D, and in 2D the mono camera at near 0.001
with far 1000 (display rig) or 5000 (camera rig). A mixed scene may want tighter depth precision,
so **`nearClip` / `farClip`** (both optional, `perf`-independent) are a **floor on near and a cap
on far**. They never widen the range, and they rewrite only the depth mapping, not the frustum.
Anything nearer than `nearClip` is clipped, splats included.

## `setRig` — switching between the display rig and the camera rig (#36)

A page with one persistent tile (one canvas, one `addSplat` handle for the whole document)
sometimes has to show something other than the photograph: a glTF product or a bird under
`handle.engine.root`, with the splat hidden. That mesh should look exactly as it would in its own
`addModel(url, { engine: 'playcanvas' })` tile, which renders through a **display rig** with 1:1
perspective. A photo, though, sits on its **camera rig**, the ~70° phone lens it was captured
with, and before 1.16 nothing could change the rig after boot: `rig` was a boot option,
`viewer.fitTo` / `setFocus` moved shared state with no way back, and writing
`handle.engine.camera` does nothing because the adapter re-places it from the views every frame.

```js
const h = addSplat(wall, canvas, photoBytes, { engine: 'playcanvas' });
await h.ready;
// a product screen:
h.mesh.entity.enabled = false;          // hide the photo
h.engine.root.addChild(productEntity);  // the page's glTF, as in § handle.engine
await h.setRig('display');              // framed like addModel, declared as a display rig
// back to the photo:
productEntity.enabled = false;
h.mesh.entity.enabled = true;
await h.setRig('camera');               // exactly the pre-switch rest render
```

`handle.setRig(type, options?)` returns a `Promise<handle>` and takes effect on the next frame.
There is no remount, no reload of the splat and no new session.

| `type` | What you get |
|---|---|
| `'display'` | A display rig framing the page's content, on **addModel's defaults**. |
| `'camera'` | The asset's capture rig, **re-resolved** from the waterfall's own inputs (the camera block, the rest-space cloud sample, `captureFit`, the caller's rig options). It is not a copy saved before the switch, so the lens, intrinsics source and focus rung are the ones a load would pick. |
| `'auto'` | Whatever the load-time waterfall picks for this asset (`typeSource` is the waterfall's again). |

- **`handle.rig`** reports the active rig. After a `setRig('display'|'camera')` its `typeSource`
  is `'setRig'`. On a display rig from `setRig`, `rig.frame` is `{ center, extent, source }`, where
  `source` is `'root'`, `'root+splat'`, `'splat'` or `'caller'`.
- **The pose resets to the new rig's rest:** yaw = pitch = 0, zoom 1, depth offset 0, and focus at
  the rig's own focus (the frame centre on a display rig, the waterfall's focus on a camera
  rig). A drag or `setPose` made under the previous rig does not carry over.
- **The view rig declared to the runtime switches with it.** The camera rig sends the same
  `cameraRigFromPose` descriptor a load sends, byte for byte. The display rig sends
  `displayRig({ virtualDisplayHeight, ipdFactor, parallaxFactor, perspectiveFactor })`, which is
  the explicit form of the `virtualDisplayHeight` shorthand `addModel` / `addSplat` build their
  layer with. It has to be explicit: after a camera rig the shorthand cannot be restored. Returning
  to the boot display rig from the shorthand sends nothing.
- **The choice sticks across `setSource`**, so a new asset is resolved on the chosen rig, until
  `setRig('auto')`.
- **`controls:'page'` throws.** The page owns the camera there; its camera is the rig.
- **The switch is a clean cut.** There is no eased transition in this version; `transitionMs` is
  ignored, with a one-time warning.

**What `'display'` frames**, in order:
1. `frame: { center, extent }` if you pass one, in `handle.engine.root`'s space.
2. Otherwise, the union of the world AABBs of every **enabled** `render` component under
   `handle.engine.root`. This is the same measurement `addModel` takes of its glTF, skinning
   included. If the splat is shown, its measured box (`handle.frame`) is included too.
3. With no meshes under root, the splat itself, exactly as a display-rig `addSplat` frames it.

**Options** for `'display'`, all optional. The defaults are addModel's, so framing, placement and
the mono camera are identical to a fresh `addModel` tile:

| option | default | |
|---|---|---|
| `virtualDisplayHeight` | `0.24` | |
| `fit` | `'contain'` | `'contain'`, `'cover'`, `'height'`, `'none'` |
| `margin` | `0.8` | |
| `depthLimit` | `4` | |
| `fitSweep` | `true` | |
| `idleSpin` | `8` | °/s after 2.5 s idle, as `addModel` (pass `0` for a still product) |
| `ipdFactor`, `parallaxFactor`, `perspectiveFactor` | `1` | on the declared display rig |
| `toneMapping` | the environment's: `'neutral'`, or `'none'` for `'room'` | applied to the page's meshes **while the splat is hidden** |
| `environment` | `'neutral'` | addModel's IBL of that name if the page has none: `'neutral'` (Sample-Viewer studio) or `'room'` (three's RoomEnvironment, [model backend § Environments](playcanvas-model-backend.md#environments--neutral-default-and-room-three)); `'none'` |
| `frame` | — | `{ center, extent }` (arrays or `{x,y,z}`) |

**Lighting and tone mapping follow addModel, but only where that is safe.** A splat tile renders
with `TONEMAP_NONE`, because splat colours are already display-referred. addModel renders meshes
with Khronos PBR Neutral and lights them with its generated neutral-studio IBL. On `setRig('display')`:
- The eye camera switches to `toneMapping` (default `'neutral'`) while the splat entity is disabled,
  and back to `'none'` on the first frame the splat is shown again.
- If the scene has no `envAtlas` of its own, the `environment` (default the neutral studio; `'room'`
  for three's RoomEnvironment) is installed as addModel installs it. A later `setRig('display')`
  with another environment swaps it. It is removed again (and `exposure` / `skyboxIntensity` /
  `skyboxRotation` restored) when the rig switches away. A page that lights its own meshes
  (`scene.envAtlas` set) is never touched. Neither is a tile with `sky: true`.
- A glTF under root with `KHR_materials_transmission` / `_volume` gets what addModel gives it
  (checked every 30 frames, since a page adds meshes whenever they load): the scene-colour grab
  pass, transmissive-first sorting and the per-eye grab UV
  ([model backend § Transmission](playcanvas-model-backend.md#transmission-khr_materials_transmission--_volume)).
  The grab pass is dropped when the rig switches away.

**MSAA is the one thing a live switch cannot match.** Antialiasing is fixed when the WebGL
context is created. `addModel` creates its context with MSAA on, and a splat tile creates it off,
because MSAA only costs memory and bandwidth on alpha-blended quads. So mesh silhouettes on a
default splat tile alias where addModel's do not. Pass `addSplat(…, { antialias: true })` (new in
1.16, PlayCanvas only) to create the tile's context with MSAA. It costs the MSAA buffer and
changes nothing else, and with it the parity below is exact.

**Gates** (headless Chrome, real GPU (Metal/ANGLE, M1 Pro), 1280×720 CSS at DPR 1). The
harness uses a fixed clock and fake stereo: two views off the mono camera, ±32 mm, skewed. Both
tiles use `idleSpin: 0`, the only non-default, to remove the time dependence. `ports_100_cam.sog`
(a camera-block photo) is the splat, hidden. The mesh is added under `root` with the engine's
container loader, as addModel loads it.

| comparison | mono MAE | stereo MAE |
|---|---|---|
| DamagedHelmet: `setRig('display')` vs `addModel` defaults, `antialias: true` | **0.0000** (max 0) | **0.0000** (max 0) |
| DamagedHelmet: same, splat tile's default MSAA off | 0.44 (edges only) | 0.43 |
| Fox (skinned): `antialias: true` | **0.0000** (max 0) | **0.0000** (max 0) |
| Fox: MSAA off | 0.11 (edges only) | 0.12 |
| Round trip: rest → `setRig('display')` (+glTF, splat hidden) → `setRig('camera')` vs rest | **0.0000** | **0.0000** |

MAE is RGB on 0–255, over the whole buffer. The MSAA-off residual is all silhouette: interior
pixels match exactly. In the round trip, the mono camera, projection, rig-node matrix, fit scale,
tone mapping and the declared camera-rig descriptor are bit-identical to before the switch. The
IBL installed for the display rig is gone afterwards.

## `setVideo` — a stereo video on the persistent handle (#36)

A page that renders everything through **one persistent woven canvas and one `addSplat` handle**
([woven canvas rules, rule 3](woven-canvas-rules.md#3-prefer-one-persistent-canvas-for-the-whole-app))
cannot put a movie in its own `addVideo` canvas. That canvas would be fresh to the compositor, and
a fresh canvas after a navigation is exactly what shows the raw side-by-side flash. So the tile's
own engine draws the video, in the tile's own frame:

```js
const v = await handle.setVideo('movie_sbs.mp4', { format: 'sbs', fit: 'contain' });
v.video.play();                      // the page owns transport: play / pause / currentTime / events
// … back to the photo:
await handle.setVideo(null);         // splat, pose, lens and declared rig exactly as they were
```

`handle.setVideo(src, options?)`:
- **`src`** is a URL or an `HTMLVideoElement`.
  - **A URL** gets an SDK-owned `<video>` (`crossOrigin: 'anonymous'`, `playsInline`). It autoplays
    unless `autoplay: false`. If the browser refuses sound without a user gesture, it plays
    **muted** (logged once); set `v.video.muted = false` on the next gesture. The SDK frees the
    decoder (pause, drop `src`, `load()`) on exit, on a replacing `setVideo` and on `remove()`.
  - **An element you pass stays yours.** The SDK never plays or pauses it unless you pass
    `autoplay: true`, and it never releases it.
- **The promise resolves on the first frame the video has**, to `{ video, format, fit, remove(),
  stats() }`. The switch happens in one task at that point: the splat is hidden, the display rig is
  declared and the plane goes up. Before that nothing changes, so there is no blank gap. A video
  that fails to load rejects, and the splat stays on screen. A call superseded before its first
  frame (a newer `setVideo`, `setVideo(null)` or `remove()`) rejects with an `AbortError` and
  changes nothing.
- **`setVideo(null)`** exits and restores everything the entry changed: the splat's `enabled`,
  yaw / pitch / zoom / depth / focus (targets included), the mono lens (a camera rig's capture lens
  comes back), the idle spin, and the declared view rig. If the declaration changed, the previous
  descriptor is re-sent byte for byte. A tile still on its boot `virtualDisplayHeight` shorthand
  gets its explicit form, since the shorthand cannot be re-sent. A second `setVideo` while one is on
  replaces the video and keeps the original pre-video state.

| option | default | |
|---|---|---|
| `format` | `'sbs'` | `'sbs'` (left eye = left half), `'tb'` (left eye = top half), `'mono'` (both eyes the whole frame) |
| `fit` | `'contain'` | `'contain'`: the whole eye image, with transparent bars where the aspects differ (the page shows through). `'cover'`: the window is full and the overflow is cut at its edges. |
| `rig` | `'display'` | Only `'display'`; anything else throws. |
| `virtualDisplayHeight` | the tile's own | The display rig's height while the video is on. A flat plane at the window has no disparity of its own, so it does not change the picture. |
| `loop`, `muted` | the element's | Applied when given. |
| `autoplay` | `true` for a URL, `false` for an element | |

**How it is drawn.**
- **The plane.** One quad is parented under the **rig node**, the eye camera's parent, at display
  space z = 0. Every `RenderView` composes the rig node, so the quad is fixed relative to the eyes
  whatever the pose, and exit has no pose to undo. On the display rig the z = 0 plane spans the
  element, so the quad is the element box contained or covered by the video's per-eye aspect. The
  quad itself has zero disparity, and the depth you see is the video's own.
- **Each eye sees only its own half.** One camera draws both views, so no per-view uniform can say
  which eye this is. The eye viewports sit side by side in the buffer, so the fragment compares
  `gl_FragCoord.x` with the first right-eye viewport's x. With N > 2 views, the first half are left
  eyes. The sample is clamped half a texel inside its half, so linear filtering never bleeds the
  other eye across the seam.
- **Not woven** (the mono path: a normal browser, or the layer is lost) draws the **left half**
  across the whole 1:1 buffer, at full resolution. The page's feather applies in 3D, as for the
  splat.
- **Upload** happens only when the element presents a new frame (`requestVideoFrameCallback`).
  A landed `seeked` event also triggers it, and without rVFC a `currentTime` change does. There is
  one RGBA8 texture per video size, re-specified from the `<video>` by the engine
  (`texImage2D`, GPU to GPU in Chromium), and no allocation per frame.
- **Colour.** The texture holds the encoded sRGB values and the shader writes them unchanged, so
  the pixels are the ones `addVideo`'s 2D-canvas paint puts in the buffer.

**Rules, as for `setRig`.**
- It applies on the next frame, with no remount, no new canvas and no new session.
- **It throws during an in-flight `setSource`**, from the call until the swap settles.
- While a video is on, **`setSource` rejects and `setRig` throws** until `setVideo(null)`.
  **`prepareSource` stays available**, so a Watch screen can prefetch the next photo.
- **`controls:'page'` throws**, because a page-owned camera has no display rig to put the plane on.
- Orbit, zoom and double-click focus are ignored while the plane is up.
- `handle.rig` and `handle.frame` keep describing the (hidden) splat.
- Only the splat is hidden. Entities the page hung under `handle.engine.root` stay as they are,
  and a page hides its own.

**Transport chrome is the page's.** The player module RFC ([`docs/rfcs/0001-media-player.md` on
`feat/player`](https://github.com/DisplayXR/displayxr-web/blob/feat/player/docs/rfcs/0001-media-player.md))
has a partial-region transport bar (`data-inline3d-overlay`). It is internal to that unmerged
module (`buildTransportBar` is not exported) and bound to `addPlayer`'s own canvas, so it is not
reused here. The integration point is `v.video`: the same `HTMLMediaElement` vocabulary
(`play/pause/currentTime/duration/ended`, `timeupdate`/`ended` events) the RFC's handle uses. If
the bar ever becomes an export taking `(container, video)`, it applies to `setVideo` unchanged. As
[rule 8](woven-canvas-rules.md#8-chrome-over-a-woven-canvas-is-a-partial-region) requires, keep the
chrome a partial region of the tile.

**Gates** (Chrome 153, real GPU (Metal/ANGLE, M1 Pro), a 1280×720 CSS tile at DPR 1, on the
camera-rig photo `ports_100_cam.sog`). The pixel gates are headless, with fake stereo: two
Kooima-correct views off the mono camera, ±32 mm, so the z = 0 window stays put. The test clip is a
synthetic 3840×1080 H.264 SBS: a red `L` on the left, a blue `R` on the right, and a 16-bit frame
barcode in both.

| gate | result |
|---|---|
| each eye only its half (6 seeked frames) | left eye: **0** blue px of 810,240; right eye: **0** red px; barcode exact in both |
| mono | the 1280×720 buffer is the left half at full res: 0 blue px, 100% plane coverage |
| exit vs the pre-video render | **MAE 0.0000** (max 0), stereo and mono; declared rig byte-identical (`display:0.24` in, the same camera rig out) |
| colour vs `addVideo`'s drawImage of the same frame | MAE 0.003, max 0.67 (flat regions 0) |
| frame tracking while playing (barcode vs the element's last rVFC `mediaTime`) | 238 / 240 draws the same frame, 2 one frame newer, **none older**, none backwards |
| `setVideo` during `setSource` | throws; works once the swap has settled |

Upload cost and pacing were measured in a **visible** Chrome on the real clip (3840×1080 H.264 SBS,
38 Mbps, 30 fps), with a 2560×720 SBS buffer on a 120 Hz panel, over 10 s:

| | |
|---|---|
| uploads | **29.9/s** (the video's rate: 299 of 1,199 draws; the other 900 upload nothing) |
| `texImage2D(video)` | p50 **0.1 ms**, p95 0.2 ms, max 1.0 (CPU). With a `gl.finish()` after it: p95 0.3 ms, max 1.5 |
| whole draw (engine tick) | 0.4 ms p50 with an upload, 0.2 ms without |
| rAF interval | p50 8.3 ms, p95 9.2 ms, none over 25 ms |
| video frames | **0 dropped** of 299; presented interval p50 33.3 ms |

## `setLayerRig` — stage objects through the display rig, on a photo's camera rig

A photo-lifted splat is on a **camera rig**, and so is everything the page draws with it. Objects a
page adds on top of the photo (a product, a UI prop, a video frame) therefore read as flat as the
photo does: the rig damps stereo and head parallax by `n/D` (the viewer's distance over the photo's
convergence distance). `setLayerRig` draws chosen **engine layers** through the **display rig**
instead — physical eyes against the physical screen — while the splat, and the rig declared to the
runtime, stay on the photo's camera rig.

```js
const h = await addSplat(wall, canvas, photoUrl, { engine: 'playcanvas' });
const { app } = h.engine;
const stage = new pc.Layer({ name: 'Stage' });
const comp = app.scene.layers;
const wi = comp.getTransparentIndex(comp.getLayerById(pc.LAYERID_WORLD));
comp.insertOpaque(stage, wi + 1);
comp.insertTransparent(stage, wi + 2);
h.engine.camera.camera.layers = [...h.engine.camera.camera.layers, stage.id];

h.setLayerRig('Stage', 'display');          // or addSplat(…, { displayRigLayers: ['Stage'] })
h.setLayerRig('Stage', 'camera');           // back to the photo's rig
```

**How.** The photo's camera rig *is* a portal: every view looks through one window on the
convergence plane. The display rig looks through the same window from the eyes the runtime's own
`ipdFactor`/`parallaxFactor` = 1 would give — the photo's eyes scaled by `k = D / (m·n)` about the
declared camera position. Two portals through one window differ only by the eye, and the affine
shear that fixes the window plane and moves one eye onto the other turns one picture into the
other **exactly**. So the display-rig views are the runtime's views, right-multiplied by that shear;
the runtime's projection matrices are used verbatim and no frustum is built (no Kooima; the
derivation and the runtime-math proof are in
[`docs/proposals/layer-display-rig.md`](proposals/layer-display-rig.md)).

- **The convergence plane is fixed pointwise.** An object's contact point on it (z = 0 in the
  photo's window frame) does not move, in any view, and has zero disparity in both rigs.
- **Mono / the 2D tier / a 1-view mode: identical to today** (one view sits at the camera; the shear
  is the identity). So is a display rig (`setRig('display')`, `setVideo`, an object splat): there
  is nothing to round.
- **Order is kept.** PlayCanvas renders camera by camera, so the tile's composition is split into
  runs: the eye camera draws everything before the display layers, a display camera (priority 1)
  draws them, and a post camera (priority 2) draws what came after them (UI: the edge feather and
  the transition overlay). Same N `RenderView`s, same viewports.
- **Depth.** The display camera clears depth (only depth) in 3D: the two camera spaces never share a
  depth test. The splat writes none; the display layers depth-test among themselves.
- **Rounding.** `viewerDistance` (m, default **0.6**, the browser's nominal) or an explicit `gain`,
  for the whole tile (last call wins). The runtime knows the real nominal distance but the browser
  does not expose it yet — a wrong value scales the objects' depth by `n_true/n`; it never moves the
  contact plane or the 2D picture.
- **Kill switch:** `?dxrdiag=nolayerrig` — requests are recorded, never applied.
- Needs the engine's `RenderView` path (the default); on the N-camera fallback it warns once and
  the layer stays on the photo rig.

**Measured** (headless Chrome, ANGLE Metal, 2560×720 SBS buffer; a splat, a z = 0 contact marker,
markers 0.5 world units in front of and behind the plane; the page plays the runtime with
`dxr_camera3d_compute_view`, and the expectation is `dxr_display3d_compute_view` on the rig the
runtime's own conversion says the photo IS, with factors 1 — an independent oracle):

| | camera rig (today) | display rig |
|---|---|---|
| contact marker, L / R x (px) | 459.5 / 459.5 (expected 459.5 / 459.5) | 459.5 / 459.5 — **unmoved, zero disparity** |
| marker in front, disparity | +8.0 px (expected +8.53) | **+28.0 px** (expected +28.44) |
| marker behind, disparity | −5.0 px (expected −5.12) | **−17.0 px** (expected −17.07) |
| off-centre, leaning head (10 cm closer) | | L/R 892.0 / 855.5 (expected 892.07 / 855.50) |
| `gain: 1` vs no layer rig | | **byte-identical** frame |
| mono, camera vs display | | **byte-identical** frame |
| after a `setSource` crossfade / at zoom 1.4× | | contact unmoved, disparity unchanged |
| per-frame cost (CPU + sync, median of 6×60 frames) | 2.65 ms | 2.51 ms — within noise; same draw count (12) |

The measured positions are centroids of axis-aligned squares, so they sit on half pixels: every one
is within 0.5 px of the oracle. The extra camera costs one depth clear and a camera's culling/sort
over the display layers' meshes; nothing else is drawn twice.

## `makeSbsMaterial` — a stereo side-by-side clip on any quad

```js
const tex = new pc.Texture(app.graphicsDevice, { width: 1920, height: 540, mipmaps: false });
tex.setSource(videoEl);                              // the page's one <video>; upload new frames as usual
const mat = h.makeSbsMaterial(tex, { format: 'sbs' }); // 'sbs' | 'tb' | 'mono'; opacity, flipY, depthTest, …
previewEntity.render.meshInstances[0].material = mat;
```

Each eye samples its own half — the left half in left-eye views, the right half in right-eye views
— exactly as `setVideo`'s full-screen plane does, on a quad of any size, anywhere, on either layer
rig. Mono / the 2D tier / a 1-view mode: the left half. The quad's geometry is untouched: put it at
the screen plane and the clip's disparity is the only depth. Nothing is decoded by the SDK.

How the eye is known: the eye viewports sit side by side in the buffer, so the SDK publishes the
first right-eye pixel column every draw as a **scene-wide uniform, `dxr_eye_split`** (`1e9` in
mono), and the shader compares `gl_FragCoord.x` with it. A custom shader can do the same by
declaring the uniform (`SBS_EYE_GLSL` in `js/inline3d-splat-video.js`); it must not set it per
material. PlayCanvas's own `view_index` uniform is also set per view on the RenderView path, but it
is 0 for every camera on the N-camera fallback, which is why the split is what the SDK uses.
Measured in the same capture: a 64×32 blue|yellow texture on a quad at z = 0 shows **only blue**
(5,184 px, 0 yellow) in the left view and **only yellow** in the right, on both layer rigs; mono
shows only blue.

## `controls:'page'` — the page owns the camera

For a game, or any page that already has a camera. The adapter stops being a viewer: no orbit,
no idle spin, no auto-fit and no focus gestures. It keeps what it is uniquely good at: the eye
math, the `RenderView` list, the footprint fix, near/far and the mono fallback.

```js
const h = addSplat(wall, canvas, src, {
  engine: 'playcanvas',
  controls: 'page',
  comfortDepth: 0.3, // default
  onBeforeFrame: ({ time, views, dt }) => {
    game.step(dt); // the page's own simulation
    splatFromWorld.copy(splatEntity.matrixWorld).invert();
    m.multiplyMatrices(splatFromWorld, camera.matrixWorld); // camera in the SPLAT's space
    h.setCameraPose(m.elements, { verticalFovDeg: camera.fov, near: camera.near, far: camera.far });
  },
});
```

**`setCameraPose(matrixWorld, { verticalFovDeg, near?, far?, convergence? })`**
- `matrixWorld`: 16 numbers, column-major. It is the page camera's world matrix **in the splat's
  own space**, the space of the camera block's `rest`, in the three.js convention (looks down −Z,
  +Y up). The adapter applies its own OpenCV → engine flip (the half-turn about X the splat entity
  carries), so the page never sees it. A block's OpenCV `rest` pose converts as `rest · Rx(180°)`.
- **A uniform scale is allowed**, and it is how page units reach the adapter. F1000's castle
  splat sits under `T·Rx(180°)·S(2.5)`, so `inv(splatWorld) · camera.matrixWorld` carries a 0.4
  scale. The rig node takes it, which puts the runtime's eye offsets (metres), the page's
  `near`/`far` and `convergence` in page units. A non-uniform scale warns once and uses the
  geometric mean. A mirrored or singular matrix throws.
- `near` / `far` (defaults 0.001 / 5000) are a floor and a cap on every projection's depth mapping,
  combined with `nearClip` / `farClip` as in 1.9.1. The frustum shape never moves.
- **Last call wins.** A page that stops calling keeps its last pose, with no snapping to anything.
  `getCameraPose()` returns a copy of the last pose, or null before the first call. Until then
  the camera sits at the asset's rest pose with the resolved lens, so the first frame is not
  empty.

**`onBeforeFrame(frame)`, the ordering guarantee.** It is called once per adapter frame: the
wall's session frame in 3D, the SDK's mono rAF in 2D. It runs **before** the tick and before any
render, with `{ time, views, dt }`: `views` is the runtime's `XRView` list in 3D (valid only
inside the call) and null in mono; `dt` is in seconds, capped at 0.1.
- **Call `setCameraPose` inside `onBeforeFrame` for zero lag.** The pose set there is the one
  this very frame renders: the attach pattern, which F1000's `dxrMode` uses today.
- **Outside it you may be one frame late.** The session rAF (3D) and the window rAF have no
  guaranteed order.
- A throw in the callback is caught and warned once, and the frame still renders.

**What renders.**
- **Mono:** exactly the page's camera. The eye is the rig node, and the projection is plain:
  `verticalFovDeg` × the canvas aspect, principal point centred. No capture window applies.
- **3D, the attach pattern** (the same contract as the auto-3D shim, `tools/auto3d-shim/core.js`):
  - The rig node carries `flip · matrixWorld`.
  - Each eye's `RenderView` gets `view.transform` as its pose. The engine composes the parent, so
    eye world = `matrixWorld × view.transform`.
  - The projection is the runtime's, untouched (depth mapping aside).
- **The rig is declared every frame**, before the draw:
  `{ type: 'camera', position 0, orientation identity, verticalFov, convergenceDiopters: 1/d,
  metersToVirtual: comfortDepth · d / 0.5, ipdFactor, parallaxFactor }`. By construction,
  comfort = `ipd × m2v × (1/d) × 0.5` = `comfortDepth`. So the depth budget is the same for a
  10 cm subject and a 150 m castle, and a game behaves the way it does under the shim.
  `ipdFactor` / `parallaxFactor` come from the options (default 1).

**Convergence `d`.**
- It is the call's `convergence` (page units, along the view axis) when given.
- Otherwise it is the **focus waterfall's** value (block › nearest clump › median disparity),
  measured once on load in model units, divided by the matrix's scale.
- It **stays fixed while the camera moves.** There is no per-frame estimation (a game camera
  whips around; a re-estimated convergence would pull the scene through the glass). It is
  re-estimated only on `setSource`.
- `setFocus(point)` sets `d` to the point's distance along the current view axis, eased unless
  `{ snap: true }`. `setFocus(null)` goes back to the waterfall's `d`.
- `getFocus()` is the convergence point on the view axis, in model space. `onFocusChange` fires
  when `d` changes (not when the camera moves).
- `pick()` casts through the page's camera, so `h.setFocus(h.pick(x, y))` is the page-owned
  double-click.

**What is refused.**
- `setPose` / `resetPose` throw with a message naming `setCameraPose`.
- `rig: 'display'` throws: the page's camera *is* the rig. `rig: 'auto'` resolves to `camera`.
- `setSource`'s `resetPose` is ignored.
- `fit`, `virtualDisplayHeight`, `orbit`, `idleSpin`, `focusInput`, `margin`, `fitSweep`,
  `depthLimit`, `orbitMaxDeg`, `orbitEase`, `zoom` and `captureFit` are ignored, named once in a
  `console.info`.
- **Spark:** `controls: 'page'` throws at call time, naming `engine: 'playcanvas'`. Supporting it
  there means teaching SceneViewer to take an external camera in both its mono and eye paths.
  SceneViewer is shared with `./viewer` and `./model`, which is more than this change should
  touch. Estimated at about a day with parity, not done.

`handle.engine` is unchanged: the page may still add entities under `root`, which is how a game's
meshes, character and lights share the splat's depth.

**Gates (1.11.0).** Headless Chrome 153 on the real GPU (ANGLE Metal, Apple M1 Pro), 1280×720,
engine 2.22.3, no other Chrome running. Grey MAE /255. The harness is the epic's parity scratch
page (`cam.html`), not shipped.

| check | result |
|---|---|
| **Equivalence, display rig** (`ports_25.sog`, yaw 20°): the page hands `setCameraPose` the exact camera the default controls use (`flip · rig · monoPose`, a 426× uniform scale, fov 35°, near/far 0.001/1000), mono | **MAE 0.000** vs the default render |
| **Equivalence, camera rig** (`ports_100_cam.sog`, block, yaw 10°, fov 51.5°), mono | **MAE 0.000** |
| **Equivalence, 3D** (fake wall, two views at ±32 mm, ±0.1 NDC skew; default eyes in display space vs page eyes in rig space) | **MAE 0.000** |
| Frames follow the pose: the page's own orbit, 0° vs 25° about the focus | MAE 19.4 (non-empty: 16–17 % of pixels lit) |
| Off-axis skew reaches the eyes untouched: ±0.1 NDC on a 1280-px eye, eyes at 0 | left eye **−64 px**, right eye **+64 px** (buffer), residual 0.000 |
| Rig pushed, per frame (456 pushes in 8 s) | `type 'camera'`, identity pose, `verticalFov` 0.61087 = 35°, `convergenceDiopters` 200.542 = 1/d, `metersToVirtual` 0.0029919 = 0.3·d/0.5, with d = 2.1246 (median disparity, model m) / 426.07 (the matrix's scale) |
| Eye separation matters in 3D (±32 mm vs 0, same skew) | MAE 12.0 |

**Not tested:** the DisplayXR Browser (a real runtime's views and rig echo, the weave), Windows
and Android; `onBeforeFrame` ordering against a real session rAF (the fake wall calls the frame
from the window rAF); F1000 itself on this mode; a non-uniform `matrixWorld` on the GPU
(fake-engine tested only); `setSource` under a page camera on the GPU.

## `setSource` — what a swap costs the main thread

Measured in headless Chrome 153 on an M1 Pro. The swap is `ports_25.sog` → `ports_100_cam.sog`
(1,179,648 gaussians, bytes), `fadeMs: 0`, 3 fresh browsers each. The "4× CPU" rows use DevTools
CPU throttling as a stand-in for a tablet. Long tasks come from a `longtask` PerformanceObserver.
The gap is the longest time between two rAFs during the swap and the second after it.

| | longest main-thread task | longest rAF gap | swap wall time |
|---|---|---|---|
| 1.10.0, 1× CPU | 60–64 ms | 65–77 ms | 195–202 ms |
| **1.10.1**, 1× CPU | **none over 50 ms** | **35–44 ms** | 152–161 ms |
| 1.10.0, 4× CPU | 218–238 ms (plus more: 318–354 ms blocked in total) | 233–249 ms | 460–497 ms |
| **1.10.1**, 4× CPU | **60–65 ms** (one task, the engine's) | **102–122 ms** | 301–352 ms |
| 1.10.0 / 1.10.1, 1× CPU, `fadeMs: 500` | 56–58 ms / none | 68–79 ms / 42–52 ms | 704–726 / 662–704 ms |

Where the time goes. The SDK's stages show as `performance.measure` entries named
`inline3d:*`, visible in DevTools; these are the 1× figures.
- **The engine's SOG load: about 90–110 ms of wall time, almost all of it asynchronous.** At
  2.22.3 the WebP planes decode through `createImageBitmap`, which is asynchronous and off the
  main thread in Chromium (its synchronous part measured 0.0–0.2 ms per plane). The zip entries
  inflate through `DecompressionStream`. The GPU centre pass plus its readback (`generateCenters`)
  is asynchronous, 35–56 ms of wall time. Texture uploads cost 1–3 ms each.
- **The one long task left is the engine's**: its end-of-load work (unpacking the centre readback
  into a Float32Array and building the resource). That is about 15 ms at 1× and **60–65 ms per
  1.18M gaussians at 4× CPU**. The engine at 2.22.3 has no worker or asynchronous parse path for a
  bundled SOG. Safari has no `createImageBitmap` path in the engine (`supportsImageBitmap` is false
  there), so the WebP decode lands on the main thread at texture upload. That was NOT measured.
- **The SDK's own passes were the rest:** the strided cloud copy (9 ms), the opacity pass (4 ms),
  the framing percentiles (46 ms, now 15 ms with a linear-time select), the rest-space sample and
  the pick set (4 ms). They used to run in one task, stacked on the engine's. Each now runs in its
  own task, with a yield (`scheduler.yield()` where available) in between. The numbers are the
  same: the framing's percentile values are bit-identical, by test.

**Recommended pattern for a document that swaps photos.** During the dwell, call
`const next = await handle.prepareSource(url)`; when the slide changes, call
`setSource(next, { transition })`. The load and decode then run while the current photo is on
screen, and the transition frame has no load on it. Keep a poster for the first paint and gate on
the `firstWoven` promise as before. On a slow device, expect one engine hitch of about 60 ms per 1M
gaussians at 4× CPU per swap, and with `prepareSource` it lands in the dwell. Without
`prepareSource`, calling `setSource` well ahead of the navigation still helps, but the transition
starts only when that load has finished.

### Transitions: the load stall, the frozen outgoing photo, and `prepareSource` (#36)

A field report from a tracked 3D panel (a slideshow, one persistent handle, `setSource` per slide,
1.18M-gaussian photos) said that "on every transition the eye tracking hangs, then resumes". There
were two candidate causes. **(A)** In 1.12.1–1.13.0 the outgoing photo is a FROZEN frame for the
whole window (800 ms crossfade, 2000 ms wavefront), so it has no head parallax. **(B)** The swap's
load (fetch, SOG unpack, our cloud passes, the engine's readbacks) stalls rendering, and with it
the eye pose the page renders with, right as the transition starts. Both are now fixed:
`outgoing: 'live'` (the 3D default) and `prepareSource()`. Details:
[`splat-effects.md` § Live or frozen outgoing](splat-effects.md#live-or-frozen-outgoing).

Measured in headless Chrome on an M1 with the real GPU and a fake 2-view wall driven from the
window rAF, with the head moving. The swap is `mg_tahoe_k100.sog` → `mg_family_k100.sog` (1.18M
gaussians each, by URL), after a warm-up swap with the same options. The CPU throttling is set on
the page's own renderer after load, and a calibration loop checks it on every run. Setting it before
the first navigation was silently lost on the cross-process navigation. Each cell is the median
[range] over 5 runs for crossfade and 3 for wavefront. Phase 1 runs from the `setSource` call to
the first frame of the transition, and phase 2 is the transition itself. Long tasks come from a
`longtask` observer; a gap is the longest time between two rAFs.

| CPU | arm | call → 1st transition frame | phase 1: longest task / longest gap | phase 2: longest task / longest gap | outgoing photo in phase 2 |
|---|---|---|---|---|---|
| 4× | 1.13.0, crossfade | 461 [452–496] ms | **104** / **138** ms | 0 / 19 ms | frozen 800 ms |
| 4× | preload (frozen) | 31 [25–33] ms | 0 / 18 ms | 0 / 19 ms | frozen |
| 4× | live | 426 [409–444] ms | 63 / 112 ms | 0 / 26 ms | live |
| 4× | **preload + live** | **28 [27–30] ms** | **0 / 18 ms** | **0 / 26 ms** | **live** |
| 6× | 1.13.0, crossfade | 645 [492–692] ms | **159** / **196** ms | 0 / 19 ms | frozen 800 ms |
| 6× | preload (frozen) | 27 [23–30] ms | 0 / 17 ms | 0 / 19 ms | frozen |
| 6× | live | 514 [472–552] ms | 89 / 111 ms | 0 / 26 ms | live |
| 6× | **preload + live** | **28 [25–30] ms** | **0 / 18 ms** | **0 / 26 ms** | **live** |
| 4× | 1.13.0, wavefront | 470 [453–494] ms | 104 / 145 ms | 0 / 19 ms | frozen 2000 ms |
| 4× | preload + live, wavefront | 30 [29–30] ms | 0 / 17 ms | 0 / 28 ms | live |
| 6× | 1.13.0, wavefront | 637 [555–640] ms | 155 / 195 ms | 0 / 20 ms | frozen 2000 ms |
| 6× | preload + live, wavefront | 28 [25–30] ms | 0 / 18 ms | 0 / 27 ms | live |

Where the preload's cost goes: into the dwell, where `prepareSource` has a longest task of
59 [56–63] ms at 4× and 91 [86–101] ms at 6×, and a longest rAF gap of 64 / 107 ms. That task is the
engine's own end-of-load (the centre readback, `generateCenters` + `getBufferSubData`). A CPU
profile showed that the 104 / 159 ms task of 1.13.0 was OURS: the framing pass
(`sampleCloudCentres` + the percentile selections) in one task. It now runs in steps (per axis,
then the window pass, bit-identical), which is why the no-preload "live" arm's phase 1 already
drops to 63 / 89 ms.

**Which one was it?** Both are real; (A) is the long one. In 1.13.0 the transition window itself
has no long task and its frames come at the normal cadence (longest gap 19–20 ms). What stands
still for 800–2000 ms is the image: the frozen outgoing photo, which on the GPU shows MAE 0.000
between four head poses. (B) is one hitch of 138–196 ms of rendering (and eye pose) in the half
second BEFORE the fade starts. Live removes (A): the outgoing photo matches its own render at every
head pose. `prepareSource` removes (B) from the transition, moving the engine's ~60–90 ms into the
dwell.

The live window's price, per frame: GPU-synced frame time (1× CPU, 2560×720, a 1-px readback per
frame) is 14.5 ms steady and 25.2–25.6 ms live (13.1–13.7 ms frozen), i.e. both photos drawn. The
second manager adds about 73 MB of GPU textures for the window only. Since the patch after 1.19.1,
the `wavefront` draws each photo only on its side of the front, and its ridge no longer rewrites
the work buffer: about 1.4× a still photo in stereo instead of 2×. The `crossfade` still draws
both. See [`splat-effects.md` § Wavefront: one draw's worth](splat-effects.md#wavefront-one-draws-worth).

### Diagnosing transition stalls (`diag` / `?dxrdiag`) (#36)

After 1.19.2 a woven panel still showed head tracking "stopping for a moment" at every Photos
transition (persistent handle, `prepareSource` in the dwell, live outgoing). Four causes look the
same on the panel, and a headless browser can only see some of them, so the handle can record what
each woven frame actually was. Turn it on with `addSplat(..., { engine: 'playcanvas', diag: true })`
or by adding `?dxrdiag=1` to the page URL (the option wins; `diag: false` turns it off).

**What is recorded, per woven frame** (the session's `onFrame`, after the draw):

| field | meaning | what it catches |
|---|---|---|
| `dt` | time since the previous session frame | a MAIN-THREAD (or GPU back-pressure) stall: the page drew nothing new for `dt` |
| `held` | every view's `transform` AND `projectionMatrix` bit-identical to the previous frame's | a TRACKING hold: frames still arrive, the eyes do not move. A live eye tracker never repeats itself to the last bit, so two or more in a row mean the browser handed back old views: it keeps the last good views when a locate reply comes back empty (for up to 29 replies), and it reuses the previous reply while its UI thread is busy |
| `delta`, `rel`, `ipd` | the largest eye move (world units), the same in eye separations, the eye separation | how much the head moved; `rel` is comparable across rigs |
| `img`, `imgW` | what the transition overlay shows: `none`, the `frozen` capture or the `live` outgoing target, and its share of the picture | a FROZEN IMAGE: poses move, but the picture on screen is a still |
| `afterRig` | a `setViewRig` push in the last 3 frames | a pose jump there is the rig, not the head |
| `phase`, `sinceCall` | `prepare` / `swap` / `window` / `settle` / `idle`, and ms since the `setSource` call | where in the transition it happened |

Also recorded: every `setViewRig` push with its values (a changed rig only: `controls:'page'`
re-declares per frame), every long task (`PerformanceObserver`), the window rAF cadence (the main
thread's own clock, separate from the session's), and marks (`prepared`, `presorted`, `outgoing`,
`live-shown`).

**Where it goes.**
- A small overlay at the bottom left, excluded from the weave. Top strip: the last 3 s, one bar
  per session frame (height = frame interval, 0–100 ms). **Red** = held poses, **orange** = the
  frozen capture on screen, **grey** = just after a rig push, **blue** = normal; the white line is
  head motion. Bottom strip: the last transition, frozen at its settle, with its verdict.
- One console line per transition, 1 s after it settles:
  `[dxr-diag] transition #N <verdict> {...}`, plus a line per rig push and per phase.
- `window.__dxrDiag`: `copy(__dxrDiag.dump())` in DevTools puts the whole record on the clipboard
  as JSON (every tile: transitions with their frame windows, events, the last ~30 s of frames).

**The verdict** (per transition, from 300 ms before the call to 1 s after the settle):

| verdict | means | next step |
|---|---|---|
| `TRACKING-HELD n frames (x ms) with frames still arriving` | the browser/runtime gave the page the same eye poses n frames running | a browser-side issue, not the page's: run the browser with `--vmodule=displayxr_weave_client=1` and look for `inline3d rig miss` counts (`no_rect`, `pose_invalid`) at the transition; line it up with the rig pushes in the same summary |
| `MAIN-THREAD gap x ms (longest task y ms)` | a session frame took more than 50 ms to come | the page (or the GPU) stalled; the long tasks and the `swap`/`window` phase say where |
| `IMAGE-FROZEN n frames (x ms) on the frozen capture` | the picture was the frozen capture at >= 0.5 weight | the frozen bridge (should be 0 since the pre-sort; see below), or `outgoing:'frozen'` |
| `CLEAN` | none of the above | if the panel still shows a stop, it is downstream of the page's frames (the weave), and the dump proves it |

**What it found headlessly, and the fix.** On the fake 2-view wall (headless Chrome, M1, real
GPU, `prepareSource` then `setSource(prepared, { transition })`, 1.18M gaussians each, head
moving; median [range] over 3–4 runs; the box was heavily loaded by other work, load average
100–300, so absolute gaps are pessimistic and the arms were interleaved run by run), the diag's
own verdict on 1.19.2 is `IMAGE-FROZEN`: from the swap until the live camera's FRESH manager has
sorted, the overlay shows the frozen capture at full weight. That is the whole picture standing
still at the start of every transition while frames and poses keep coming. The pre-sort (next
release; [`splat-effects.md` § Live or frozen outgoing](splat-effects.md#live-or-frozen-outgoing))
removes it:

| CPU | transition | frozen-image frames (ms), 1.19.2 | pre-sort | `setSource` call → swap, 1.19.2 | pre-sort |
|---|---|---|---|---|---|
| 1× | crossfade | 3 [2–7] (162 [111–260] ms) | **0** | 78 [65–112] ms | 245 [110–278] ms |
| 1× | wavefront | 4 [4–5] (67 [66–83] ms) | **0** | 32 ms | 116 [114–132] ms |
| 4× | crossfade | 6 [4–6] (108 [66–117] ms) | **0** | 27 [22–29] ms | 125 [123–140] ms |
| 4× | wavefront | 6 [5–7] (133 [99–183] ms) | **0** | 25 [24–27] ms | 111 [109–141] ms |
| 6× | crossfade | 8 [5–15] (330 [86–666] ms) | **0** | 37 [30–54] ms | 164 [136–238] ms |
| 6× | wavefront | 5 [5–5] (124 [117–134] ms) | **0** | 32 [29–33] ms | 150 [125–161] ms |

The cost is the second pair of columns: the transition starts ~80–130 ms later (the sort), while
the current photo is still on screen and live, which is invisible in a 6 s slideshow.

Main thread from the call to 30 frames after the swap (the same runs; CPU throttling set on the
page's renderer AFTER navigation, calibrated before and after each run): no sort runs on the main
thread (the engine sorts on a worker per gsplat manager). What does run at the swap: a new
manager for the live camera (a sort WORKER created from a Blob URL), `setCenters` copying the
1.18M centres (14 MB) for each manager that gets a new asset (≈45 ms self time at 6× for the
two), render-target / work-buffer texture allocation, `applyLoaded`'s rig pass (4–12 ms; 31 ms
once at 6×) and native GL time. Longest task: at 1×, none over 50 ms in 5 of 6 runs; at 4×,
1.19.2 had 52–82 ms tasks on the swap frame in 2 of 7 runs, the pre-sort none; at 6×, 1.19.2 had
118–278 ms on the swap frame in 4 of 7 runs, the pre-sort 59–123 ms in 2 of 6, at the START of the
pre-sort (the live manager's creation moved there), with the current photo live on screen. So yes,
a single task can exceed 30 ms under 4–6× throttling; on an unthrottled M1 it usually does not.
The diag reports it on the panel as `MAIN-THREAD gap`.

**Kill switches for A/B on the panel** (comma-separated, in `diag` or `?dxrdiag=`, e.g.
`?dxrdiag=norig,frozen`; any switch also turns diag on):

| switch | does | tests |
|---|---|---|
| `norig` | the rig declared before the first `setSource` stays declared; every later re-declaration is dropped (logged as `rig-dropped`). The incoming photo renders through the kept rig: its lens is wrong, accepted for the test. | "the rig change makes the browser/runtime hold or re-filter the eyes" |
| `frozen` | forces `outgoing: 'frozen'` on every `setSource` | the old photo as a 800–2000 ms still: the unmistakable "hung" look, as a reference |
| `nowarm` | skips the transition shader pre-warm (`prepareSource` / `setSource` compile nothing ahead) | a first-frame shader link |
| `cold` | skips the live outgoing pre-sort (the 1.19.2 path: the frozen capture bridges until a fresh manager has sorted) | the frozen bridge |
| `nooverlay` | records, logs and dumps, no overlay | the overlay's own cost |
| `oldpick` | `handle.pick()` always runs the full scan over every centre, no pick index (the 1.21.1 path) | "the page's own picks block the main thread at the swap's end" |

The recipe on the panel: run the Photos show with `?dxrdiag=1` for three or four transitions and
read the console verdicts; then `?dxrdiag=cold` and `?dxrdiag=norig` the same way; paste
`copy(__dxrDiag.dump())` from each. Costs: a few floats per frame and one 2D canvas repainted at
10 Hz; nothing when off.

**What is on the main thread (1.21.2).** A stall at the swap's END (phase `settle`) is not
necessarily the transition. The summary now also carries, per phase (`swap` / `window` /
`settle` / …):

| field | what | how |
|---|---|---|
| `gl` | every GL call that can block: `compile`, `link`, `linkQuery` (a `LINK_STATUS` query resolves the link), `programQuery`, `shaderQuery`, `poll` (`COMPLETION_STATUS_KHR`, non-blocking), `readPixels`, `readback` (`getBufferSubData`), `fence`, `wait` (`clientWaitSync`), `finish` — count and total ms | the tile's own context is wrapped while diag is on; a single call ≥ 8 ms is also an event (`type: 'gl'`) |
| `picks` | `handle.pick()` calls: count and total ms; each task's burst is an event (`type: 'picks'`, with how each pick ran: `scan`, `build`, `index`) | the SDK times its own `pick` |
| `afterSettleTaskMs` | how long the task that ran the SDK's settle kept running AFTER it: the page's continuation of `await setSource` in that same task (the SDK's own settle work is the `settle-sdk` mark) | a message posted from the settle |
| `longFrames` | long animation frames (Chrome 123+) with their top three scripts: file, function, invoker, ms — the page's code or the SDK's, by name | `PerformanceObserver('long-animation-frame')` |

The verdict names them: `MAIN-THREAD gap 1341 ms (longest task 348 ms) — pick() ×105 1290 ms; page
code 340 ms in the settle task; top script estimatePivotDepth@page-….js 990 ms`. The SDK's settle
teardown is also a User Timing measure, `inline3d:settle:teardown`, for a DevTools trace.

**Found with it: the page's picks, not the SDK's settle.** A photo slideshow app on the panel
(ANGLE on D3D11) showed, at EVERY swap's end, two back-to-back long tasks of ~250–415 ms and
~950–1100 ms: 1.3–1.5 s with no session frame. Counting every blocking GL call through a whole
`reassemble`, `crossfade` and `wavefront` (headless Chrome, ANGLE Metal, the call-counting
harness): **zero** compile, link, status query, readback or sync from the call to 1.5 s after the
settle, on 1.21.1 already — the transition programs are pre-warmed in the dwell, and the settle's
return to the base program reuses the program compiled at page load. What does run there is the
page: on every swap it plans its companion's waypoints with 24 `pick()` calls in the task that
resolves `setSource`, then, two frames later, a 9×9 grid of 81 more. Each pick was an exact scan of
all 1.18M centres (~7.5 ms on an M1): 24 → ~190 ms, 81 → ~630 ms — the panel's two tasks, at the
panel's slower CPU, and the same ratio. Replaying just those picks after the swap reproduces the
two long tasks headlessly on 1.21.1 with no GL call in them.

1.21.2 gives the full-set pick a **pick index**: a second pick from the same eye position buckets
every centre once by its direction from the eye (about two scans), and every further pick from
there reads only the cells its cone can reach — the same point as the full scan, exactly (it
declines, and the full scan runs, when the cone is empty). The same replay: 24 picks 33–44 ms, 81
picks 31–35 ms, no long task, 0 GL calls at the settle (was 165–195 ms + 530–635 ms). A page that
picks once per frame pays what it always did (the first pick from an eye is the plain scan).
`?dxrdiag=oldpick` restores the full scan for an A/B.

**The structural A/B: `transition: 'reassemble'`.** A sequence transition has no second camera, no
overlay and no capture: one photo at a time, drawn by the eye camera every frame
([`splat-effects.md` § Sequence transitions](splat-effects.md#sequence-transitions-one-splat-at-a-time)).
If the panel still shows a stop with it, the transition machinery is ruled out. The diag records it
with `detail.transition` = `'reassemble(assemble>assemble)'` and the marks `sequence`, `out-done`,
`released`, `loaded`, `adopted`, `in-start`; its frozen-image count is 0 by construction. The one
main-thread cost left (the next file's decode and upload, and the engine's first frame of the new
asset) lands between `released` and `in-start`, when nothing is drawn.

## `perf` on this engine

| Spark knob | engine | note |
|---|---|---|
| `alphaRadius` | always on | the engine already cuts each quad at its own alpha radius (`clipCorner`) |
| `minAlpha` | `scene.gsplat.alphaClipForward` | engine default is already 1/255 |
| `maxStdDev` | `gsplatCommonVS` override | only ever shrinks, down from √8σ |
| `minPixelRadius` | `scene.gsplat.minPixelSize` = 2 × r | the engine compares a quad *diameter* |
| `lod*`, `maxPixelRadius`, `falloff`, `alphaFloor` | none | named once in a warning, then ignored |
| (engine-native) `splatBudget`, `minPixelSize`, `alphaClipForward`, `antiAlias` | passed through | win over the mapping |
| (engine-native, Streamed SOG) `lodMode`, `lodUpdateDistance`, `lodUpdateAngle`, `lodUnderfillLimit` | passed through | unset = engine default; each is its own kill switch |

**The one default changed is `minPixelSize`.** The engine default is 2 px; Spark keeps sub-2px
splats. So every `perf` value except `false` starts from 0. **`perf: false` is the kill switch:**
engine defaults, untouched. `splatBudget` is a no-op on a flat `.sog`: 1,179,648 of 1,179,648
drawn at a 600k budget. It only acts on a Streamed SOG, where it defaults to **600k per tile**
(both eyes included) instead of the engine's 1M; `perf: false` keeps the 1M (§Streamed SOG).

## Zoom bounds and relax

`zoom: { min, max, relax, ease }` (1.19). The defaults are the old behaviour: a 0.2–6 range and no
relax.

- **Input.** The wheel (a trackpad pinch arrives as a ctrl-wheel and takes the same path) and a
  **two-finger pinch** (Pointer Events; zoom = the zoom at the second touch × the ratio of the
  fingers' spread) both clamp to `[min, max]`, and so does `setPose({ zoom })`. The second finger
  ends a drag, whose tilt relaxes, and the finger left after a pinch does not orbit.
- **Relax.** With `relax: true` the zoom eases back to its rest (1×, or the last `setPose` zoom)
  once the wheel has been idle for 150 ms (`ZOOM_WHEEL_IDLE_MS`) or the pinch ends. It never
  starts during a live gesture. It is the orbit's exponential (τ = `ease`, default
  `ORBIT_TAU_REST_S` = 0.6 s) in log-zoom, with one addition: it never moves slower than
  `ZOOM_RELAX_MIN_RATE` (0.025 log-zoom/s). A pure exponential leaves 2× at 1.003× after 3 s, which
  is still visible against the rest render. With the floor, 2× lands exactly on 1× in about 2.9 s,
  with no snap. A wheel tick mid-relax continues from where the zoom is.
- **About the focus.** The pivot is `T(orbitCentre + depth) · R · S(fit × zoom) · T(−focus)`, so
  the zoom scales the subject about the focus. The focus keeps its display position, so it keeps
  its screen position in each eye and its disparity (zero when it sits on the glass).
- **Gate** (Apple M1 Pro, ANGLE Metal, headless, 1280×720 canvas, `{ min: 1, max: 2, relax: true }`):
  - Ten wheel-out notches from rest leave the zoom at 1 (MAE 0 against the rest render).
  - A wheel-in or pinch reaches the 2× cap. After release the render is at MAE 0 against rest by
    3 s.
  - Fake stereo: the focus's predicted disparity is identical at 1×, 1.5× and 2×, both on the zero
    plane and off it. The measured disparity agrees within patch-match noise (4–8 px vs 0; 103–105
    vs 99.6).

## Divergences from the Spark path

What is left after the parity pass. Everything else is the same option, the same method and the
same numbers: the viewer constants are shared, and a side-by-side trace test pins SceneViewer and
the PlayCanvas viewer bit-identical through fit, focus easing, wheel, clamps, idle spin, `setPose`
and `resetPose`.

- **The orbit drag is tilt-and-relax, by design.** The drag is a fraction of the tile, measured
  from the press, and capped at ±`orbitMaxDeg` (15°). It eases with τ = 0.2 s and relaxes back to
  rest with τ = 0.6 s on release. SceneViewer (Spark) still turns cumulatively (a full-width drag
  = 180°). The constants are shared, so switching Spark over later is a one-line change.
- **Zoom bounds, relax and pinch are PlayCanvas-only** (§Zoom bounds and relax). SceneViewer keeps
  the fixed 0.2–6 wheel range and has no pinch.
- **`handle.viewer` is a `PlayCanvasSplatViewer`.** It has the same pose surface and constants,
  but it is **not** field-compatible with SceneViewer: pages that write SceneViewer's private
  fields (`_targetYaw`, `_fitScale`, `_eye`, `monoCamera`, …) need a path for this backend.
  `handle.engine` is the supported way in. `viewer` is also null until the adapter module has
  loaded (calls made before that are queued).
- **`mesh`** is `{ numSplats, entity, asset, resource }`, not a Spark `SplatMesh`. There is no
  `spark` field.
- **`pick`** is the exact nearest gaussian CENTRE to the ray over the full centre set, not a
  surface raycast (Spark tries its raycast first). On a Streamed SOG it runs over the resident
  chunks only.
- **`setSource`** is PlayCanvas-only; on Spark it throws.
- **No sky box.** The eye camera renders without the engine's Skybox layer, so nothing is drawn
  behind the splat even when a page sets `scene.envAtlas` to light its own meshes. A hidden splat
  shows the page, not a grey gradient box. Pass `sky: true` for the engine's sky (1.10.1).
- **`sortIntervalMs` is a no-op**: the engine re-sorts on camera rotation, with one directional
  sort for every view.
- **URL `.sog` gets its `camera` block** (the engine keeps unknown `meta.json` keys). On Spark,
  only the bytes path can read it.
- **Streamed SOG** has no cloud pass. It is framed from a count-weighted sample of its octree leaf
  boxes (not the root bound), so a block without intrinsics falls to the 28 mm lens and the
  nearest-clump rung cannot run. `mesh.numSplats` is the finest level's count; `stats().resident`
  is what is drawn. Budget, knobs and measurements: §Streamed SOG.
- **Memory:** the cloud pass copies a strided ≤200k-splat sample (about 3.1 MB on the 1.18M bench
  asset) and drops it after `ready`. The exact pick keeps one opacity byte per splat (1.18 MB)
  and reads the engine's own centre array at pick time.
- **Engine hygiene** (not user-visible, recorded because each one bit when it was absent):
  - The canvas CSS is never touched: no `setCanvasFillMode` / `setCanvasResolution`.
  - Every `Entity` is built with its tile's `app`, not the engine's global one.
  - `setSource` disables the old splat and destroys and unloads it a few frames later; tearing it
    down in the same frame throws inside the engine.

## Gates (P1)

Measured in headless Chrome 153 on the real GPU (`ANGLE Metal, Apple M1 Pro`), with the
`ports_100_cam.sog` bench asset (1,179,648 gaussians, v2 camera block) on a plain SDK page loading
bytes. Reference: the source left photograph, 1280×720. Grey MAE /255.

| rest view (mono, camera rig from the block) | MAE vs photo |
|---|---|
| Spark (`engine` unset) | 2.94 |
| **PlayCanvas** | **2.25** |
| PlayCanvas vs Spark directly | 1.49 |

Display rig, PlayCanvas vs Spark directly: `ports_25.sog` 0.79, `ports_100_cam.sog`
(`rig:'display'`) 0.53.

Synthetic stereo, with the SDK's real 3D path driven by a stand-in wall: two views of the capture
camera at ±32 mm and ±0.02 NDC skew, on a 2560×720 SBS buffer. PlayCanvas vs Spark directly:
**1.14**, with the footprint fix on. The unfixed engine was not re-run here; the P0 spike measured
11.5 without the fix, against a square-pixel reference.

Several PlayCanvas tiles on one page each render their own splat (checked with 4 tiles, mixed
camera and display rigs). A page that never passes `engine` makes **0** `playcanvas` requests.

### GPU time per frame

`EXT_disjoint_timer_query_webgl2`, `TIME_ELAPSED` around exactly one config's frame per rAF. The rest
pose is pinned, the asset is `ports_100_cam.sog` (1,179,648 gaussians), DPR is 1, 60 warm-up frames,
then 300 measured frames. Values are median / p90 in ms, headless Chrome 153 on the real GPU (ANGLE
Metal, Apple M1 Pro), idle machine.

**Each config is loaded ALONE, one page load per config, in one Chrome process** (`parity/perf_solo.mjs`).
An earlier interleaved run (several canvases in one page, alternating frames) was NOT usable: on
ANGLE-Metal a context's timer query absorbs other contexts' in-flight GPU work — PlayCanvas read
27–50 ms paired with a Spark tile and 6.5–15 ms paired with another PlayCanvas tile. Interleaving
still guards against clock drift between processes; a solo load in one process guards against both.

| config | 720p | 1080p |
|---|---|---|
| Spark `exact` | 60.5 / 66.2 | 75.4 / 80.7 |
| Spark `balanced` | 51.8 / 56.0 | 64.5 / 72.7 |
| PlayCanvas default (`minPixelSize` 0) | 7.4 / 9.5 | 10.0 / 10.5 |
| PlayCanvas `balanced` (quad √6σ) | 7.1 / 9.5 | 9.1 / 9.9 |
| PlayCanvas `splatBudget` 600k | 7.4 / 9.7 | — |
| **stereo**, 2 views, SBS (2560×720 / 3840×1080): Spark `exact` | 120.0 / 136.0 | 162.7 / 179.0 |
| **stereo**, 2 views, SBS: PlayCanvas default | 12.7 / 13.2 | 35.5 / 38.4 |

- `gsplatCount` is 1,179,648 in every PlayCanvas row, **600k budget included**: the budget does
  nothing on a flat `.sog` (no LOD levels to trade), and its time matches the default within noise.
  The budget is a P2 (Streamed SOG) lever.
- On this photo-lift asset the PlayCanvas quad path is ~8× cheaper than Spark in mono and ~5–9×
  in stereo. Both engines pay ~2× for two views here. Treat the table as ranking + order of
  magnitude on one GPU; re-check on the Windows box.
- Every drawn frame was checked non-empty (mean canvas luminance ~123) in every row.

**Wall-clock check (the honest number).** The timer query above OVERSTATES Spark: measured by rAF
cadence on the same page, alone on an idle GPU (two repeats each, vsync on, 6 s windows):

| config | rAF Hz | ms/frame |
|---|---|---|
| Spark `exact`, mono 1280×720 | 35.5 | 28.2 |
| PlayCanvas default, mono | 60.2 (vsync cap) | ≤ 16.6 |
| Spark `exact`, 2-view SBS 2560×720 | 17.0–17.2 | 58.3–58.8 |
| PlayCanvas default, 2-view SBS | 59.0–60.2 (vsync cap) | ≤ 16.6–17.0 |

So on this asset the stereo ratio is **at least 3.5×** (Spark 58 ms vs PlayCanvas at the cap; the
timer query puts PlayCanvas near 13 ms, i.e. ~4.5×), and mono at least 1.7×. Quote these, not the
timer-query ratios. Why the query overstates Spark is not established (its bracket likely spans
Spark's sort readback pipeline); the PlayCanvas query values are consistent with the cadence.

## Streamed SOG (P2)

A **Streamed SOG** is a directory: `lod-meta.json` (an octree of chunk boxes, per-level counts,
relative file names) plus one unbundled SOG per chunk per LOD level. The engine fetches only the
chunks the camera needs and draws at most a **splat budget** of them. On this backend:

```js
// the lod-meta.json, or the directory that holds it
const h = addSplat(wall, canvas, 'https://cdn.example/scene/v1/lod-meta.json', { engine: 'playcanvas' });
const h2 = addSplat(wall, canvas, 'https://cdn.example/scene/v1/', { engine: 'playcanvas', perf: { splatBudget: 400000 } });
h.stats(); // { kind:'streamed', resident, peakResident, budget, numSplats, views, lodLevels, files, filesLoaded, firstFrameMs }
```

- **URL only.** Bytes of a `lod-meta.json` (`Uint8Array` / `ArrayBuffer`) make `addSplat` throw at
  call time with a message giving the URL form; a `Blob` (and `setSource`) rejects with the same
  message. The file names hundreds of chunks by relative path, and bytes have no base URL to
  resolve them.
- **The camera block** is read from the top level of `lod-meta.json` (sibling of `asset`). It is
  the same block as in a `.sog`, and it drives the same waterfall: intrinsics present ⇒ camera rig
  at the recorded rest pose. Verified on a streamed scene: `rig.type 'camera'`,
  `intrinsicsSource 'block'`, and the mono pose equal to `capturePose(rest)` to 4 decimals, the
  same as the flat `.sog` of the same scene.
- **Framing without a block** uses the octree's leaf boxes, not its root. The root bound is the
  raw container of every chunk, sky shells and floaters included: 391×821×390 m on a captured
  castle whose flat file measures 65×25×76 m, and ±240 m around a 2 m statue. The adapter spreads a
  count-weighted, deterministic sample through the leaf boxes (`octreeSample`) and frames it the
  way a flat cloud is framed. That lands within a node size of the flat measurement: 101×33×114 m
  on the castle. A caller `frame` wins over both.
- **`pick`** searches the centres of the chunks currently resident (P1's exact-pick change), so it
  can only hit what the budget let in. Not measured here.
- **`engine: 'spark'`** cannot read a Streamed SOG. A streamed URL with `engine: 'spark'` makes
  `addSplat` throw at call time with a message naming `engine: 'playcanvas'`, before Spark is
  handed the URL.

### The budget model

`splatBudget` is **per tile, and covers every view of the tile**. Pinned in
`SPLAT_BUDGET_MODEL` (`js/inline3d-splat-perf.js`) and held by a test:

- Every tile is its own `AppBase`, so it has its own scene, its own `scene.gsplat.splatBudget` and
  its own gsplat manager. Two tiles on a page have two budgets.
- The engine keys gsplat managers by **camera** (`GSplatDirector.camerasMap` holds one
  `GSplatManager` per camera × layer), and this adapter draws all N views through **one** camera
  with N `RenderView`s. So there is one manager, one LOD pass, one budget and one work buffer for
  both eyes. Measured on the castle at 600k, reading `renderer.gsplatDirector` in the page:

  | path | cameras | managers | scene budget | resident |
  |---|---|---|---|---|
  | mono | 1 | 1 | 600,000 | 588,879 |
  | 2 views, RenderView (default) | 1 | 1 | 600,000 | 590,331 |
  | 2 views, N-camera fallback | 2 | 2 | 300,000 each | 734,764 |

- The N-camera fallback (`playcanvasViewPath: 'cameras'`) makes one manager per view, each reading
  the same scene budget. The adapter divides the budget by N there (`budgetPerManager`).
- **The budget has a floor.** The engine never draws a chunk coarser than its coarsest level, so
  `resident` bottoms out at the sum of the visible chunks' coarsest levels: 367,382 on the
  castle's 5-level pyramid at a 300k budget, and 2 × 367,382 on the fallback above. Add levels
  when you need a lower floor.
- LOD distance is measured from the camera node, which sits on the first view's eye. Both eyes
  use the LOD it picked.
- **Default 600k** (`STREAMED_SPLAT_BUDGET`) when the caller names none; `perf: false` keeps the
  engine's 1M. On the M1, 1M also fits: the castle's two-view 1080p frame is 10.9 ms at 1M and
  9.6 ms at 600k. 600k is chosen for **headroom** on the weaker GPUs a 3D display ships with
  (Windows iGPUs and Android tablets, not measured yet). Only 600k and 1M were measured, so 600k
  is a safe default, not a tuned optimum. Revisit it with the Windows-box numbers.
- The LOD knobs `lodMode` (`'distance'` | `'error'`), `lodUpdateDistance` (file units, engine
  default 1), `lodUpdateAngle` (degrees, default 0 = off) and `lodUnderfillLimit` (default 0) pass
  through `perf`. Unset means the engine's default.

### Producing one (with the camera block)

splat-transform's `lod-meta.json` writer takes **PLY inputs only**, one per `--tag-lod` level.
`-d` must be the last action and must write a `.ply`. The recipe (5 levels, uniform decimation,
splat-transform's default chunking of 512K gaussians / 16 m):

```bash
splat-transform -w scene.sog  levels/lod0.ply
splat-transform -w levels/lod0.ply -d 50%    levels/lod1.ply
splat-transform -w levels/lod0.ply -d 25%    levels/lod2.ply
splat-transform -w levels/lod0.ply -d 12.5%  levels/lod3.ply
splat-transform -w levels/lod0.ply -d 6.25%  levels/lod4.ply
splat-transform -w levels/lod0.ply -l 0 levels/lod1.ply -l 1 levels/lod2.ply -l 2 \
                   levels/lod3.ply -l 3 levels/lod4.ply -l 4 out/lod-meta.json
```

A PLY has nowhere to hold the camera block. So neither the released splat-transform (3.6.1) nor
the camera-block build (upstream PR for #319, which does carry the block from
`.sog`/`meta.json`/`lod-meta.json` to `lod-meta.json`) can carry it through this recipe: the block
has to be **injected at the top level of `lod-meta.json` afterwards**. The gallery repo's
`scripts/make_streamed_sog.ts` does all of this, reading the block from the input `.sog` or from
`--camera block.json`. It checks the result and refuses inputs under 2M gaussians unless `--force`
is given. Its README section ("Streamed SOG") explains why photo lifts never qualify.

### Serving it

Upload the whole directory to the **same bucket** as the flat assets, under an **immutable,
versioned prefix** (`…/{id}/streamed-v1/`, `Cache-Control: public, max-age=31536000,
immutable`). The chunk paths are relative, so any prefix works. A rebuild goes to a new prefix,
never over the old one: a viewer mid-stream would otherwise mix levels from two builds. Cross-origin
hosting needs CORS on every chunk (`Access-Control-Allow-Origin`). The public Trogir scene below
serves `*`.

### Measured

Headless Chrome 153 on the real GPU (`ANGLE Metal, Apple M1 Pro`), engine 2.22.3, one config per
page load, HTTP cache **off**, no other Chrome running. Harness: `m.html` + `measure.mjs` (the
epic's parity scratch, `p2/`). Local assets are served from `python3 -m http.server` on localhost,
and Trogir comes over the network from CloudFront. GPU = `EXT_disjoint_timer_query_webgl2` around
exactly one frame per rAF, 300 frames after 60 warm-up, rest pose, median / p90 ms. "Stereo" is
the SDK's real 3D path driven by a stand-in wall with two synthetic views (±32 mm): a 2560×720 or
3840×1080 SBS buffer. First frame = `stats().firstFrameMs` (ms since navigation start, first tick
that drew a non-empty set). It includes loading the SDK, three and Spark from a CDN (static imports of `./splat` when this
was measured, on p1 @ `ebeb1b2`) and the engine from localhost. Bytes =
CDP `Network.loadingFinished.encodedDataLength` for the asset's URLs.

Scenes:

- **(A) museum statue** — a captured room, 364,374 gaussians, with a camera-rig block (rest pose
  in front of the statue, fx = fy = 1100 at 1280×720, `focus.point` = the opacity-weighted
  centroid of opacity > 0.5 splats inside the statue's box: (−0.368, −0.084, −0.468)). Flat
  `.sog` 5.83 MB. Streamed: 5 levels (100/50/25/12.5/6.25 %), default chunking, 16.4 MB on disk.
  `streamed32` is the same scene with `--lod-chunk-count 32` (23 files, 22.2 MB).
- **(A′) captured castle on a hill** — 5,878,108 gaussians, no block (display rig). Flat `.sog`
  79.75 MB. Streamed: 5 levels, default chunking, 23 files, 196.3 MB on disk. The streamed runs
  pass the flat run's measured `frame`, so both render the same camera.
- **(B) Trogir** — `https://d28zzqy0iyovbz.cloudfront.net/14bac5b2/v1/lod-meta.json`, public,
  45,756,761 gaussians over 7 levels (23.1M finest), 86 files, per-chunk LOD errors, an
  environment splat. It has no camera block, so it runs on the display rig, auto-framed from the
  leaf boxes. There is no flat baseline.

**First frame and bytes at rest** (mono 720p; first frame is the median of 3 loads; 100 Mbit/s =
CDP-throttled, 20 ms latency, median of 2):

| scene | first frame, localhost | first frame, 100 Mbit/s | bytes at rest | resident at rest (budget) |
|---|---|---|---|---|
| A flat | 562 ms | 2,588 ms | 5.83 MB | 364,374 (all) |
| A streamed | 608 ms | 2,443 ms | 5.98 MB | 364,374 (600k) |
| A′ flat | 1,578 ms | **20,758 ms** | 79.75 MB | 5,878,108 (all) |
| A′ streamed | 627 ms | **2,902 ms** | 138.1 MB | 593,001 (600k) |
| B streamed (CloudFront) | 837 ms | — | 13.0 MB | 604,809 (600k) |

**Bytes after a 10 s scripted orbit** (yaw ±60°, pitch ±10°, zoom 1→2.5→1; cache off, so an
evicted chunk is fetched again: total / unique):

| scene | at rest | after orbit, total | after orbit, unique URLs |
|---|---|---|---|
| A flat | 5.8 MB | 5.8 MB | 5.8 MB |
| A streamed (600k) | 6.0 MB | 6.0 MB | 6.0 MB |
| A streamed32 (600k) | 9.0 MB | 9.0 MB | 9.0 MB |
| A′ flat | 79.8 MB | 79.8 MB | 79.8 MB |
| A′ streamed 600k | 138.1 MB | 301.5 MB | 165.9 MB |
| A′ streamed 1M | 139.9 MB | 264.7 MB | 165.9 MB |
| B 600k | 13.0 MB | 31.8 MB | 31.8 MB |
| B 1M | 21.2 MB | 51.2 MB | 51.2 MB |

**Streaming is not a byte saving at a close framing.** The castle fetched more than its whole flat
file before settling. The engine loads whole chunk files per level, and coarse levels come in
before fine ones. It is a first-frame and frame-time lever. Trogir, framed whole from far away,
is the case where it also saves bytes: 13 MB of a 23M-splat finest level.

**GPU ms/frame** (median / p90; resident was constant through every timed run; **every row ran
with no other Chrome on the machine**: the driver checks for foreign headless Chromes before and
after each config and retakes a config that overlapped one):

| scene · budget | 720p mono | 1080p mono | 2 views 2560×720 | 2 views 3840×1080 |
|---|---|---|---|---|
| A flat (364k drawn) | 4.2 / 6.2 | 7.1 / 9.2 | 7.5 / 8.8 | 8.5 / 9.1 |
| A streamed 600k (364k drawn) | 3.8 / 6.0 | 7.2 / 9.7 | 7.6 / 10.1 | 8.6 / 10.8 |
| A streamed 300k (299k drawn) | 3.8 / 4.6 | — | 7.1 / 9.8 | — |
| A′ flat (5.88M drawn) | 67.7 / 72.1 | 66.3 / 70.4 | 133.7 / 155.9 | 116.9 / 122.4 |
| A′ streamed 600k (593k) | 6.4 / 8.6 | 5.9 / 8.2 | 9.8 / 13.9 | **9.6 / 12.9** |
| A′ streamed 1M (989k) | 7.3 / 10.4 | 7.8 / 10.6 | 11.3 / 12.6 | **10.9 / 13.3** |
| A′ streamed 300k (367k: the floor) | 4.1 / 6.7 | — | — | — |
| B 600k (605k) | 7.0 / 9.8 | 6.1 / 8.7 | 7.7 / 9.1 | 8.3 / 11.1 |
| B 1M (1.006M) | 9.4 / 11.8 | 9.3 / 12.6 | 10.4 / 12.4 | 10.3 / 11.9 |
| B 600k, `lodMode:'error'` (591k) | 6.0 / 8.6 | — | — | — |

**Why "no other Chrome" is load-bearing.** On ANGLE Metal a timer query absorbs other processes'
GPU work. An earlier pass that only checked for other Chromes at start-up read the castle's
two-view 1080p at 1M as 36.8 / 64.2 ms. The clean retake reads 10.9 / 13.3. Other rows moved by
2–4× the same way (castle 600k, two views at 720p: 17.8 contaminated, 7.8–9.8 in clean runs). Those passes are
discarded; only the clean retake is in the table. Even clean, treat the numbers as ranking and
order of magnitude: headless, vsync-free, one run per row. `lodMode:'error'` on Trogir loaded 42
of 86 files (252.6 MB) against 3 (13.0 MB) in distance mode.

**Rest-view fidelity, streamed vs flat** (A, same camera from the block; grey MAE /255 at
1280×720 against the flat render; flat vs flat reloaded = 0.000):

| budget | resident | MAE (default chunking) | MAE (`streamed32`) |
|---|---|---|---|
| 1M | 364,374 | 0.241 | — |
| 600k | 364,374 | 0.241 | 0.155 |
| 300k | 298,623 / 293,007 | 1.264 | 1.182 |

A′ (castle, `frame` pinned to the flat's): 1M 4.51, 600k 5.63, 300k (the 367k floor) 10.47. At a
full budget, A's residual is re-encoding. The chunk SOGs are encoded from PLY, independently of
the flat `.sog`, with their own codebooks. On the castle, the budget is doing its job: 5.88M
become 0.6–1M, and fine grain becomes coarse levels, most visibly on the near ground.

**Pending:** the same table on the Windows box (Leia SR, the DisplayXR Browser's real inline-3d
views, the weave) is not measured here.

### Not tested (P2)

The DisplayXR Browser (real inline-3d views, the weave join, zero-copy read), Windows and Android;
a real 3D wall driving the streamed path (only the stand-in wall); multiple streamed tiles on one
page (separate budgets are asserted from code, not measured); `lodUnderfillLimit` /
`lodUpdateAngle` effects (they are wired and unit-tested, not measured); HTTP-cache behaviour on
re-fetch (every run had the cache off); `remove()` during an in-flight chunk load; context loss
mid-stream; engine versions other than 2.22.3.

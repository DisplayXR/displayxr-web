# auto-3D for existing three.js and PlayCanvas pages (prototype)

Turns an ordinary, already-published three.js or PlayCanvas page into a woven glasses-free-3D
window in the DisplayXR Browser, **with no change to the page**: no SDK import, no WebXR, no source
edit. It is a prototype for measuring coverage on real sites, in the same spirit as
`tools/immersive-shim/` (which does the same for WebXR `immersive-vr` pages). It is not a product
and must not ship as one. How it would fold into the browser: [`docs/proposals/auto3d-browser-integration.md`](../../docs/proposals/auto3d-browser-integration.md).

## Architecture: one core, one adapter per engine

```
manifest.json  ->  core.js  ->  three-adapter.js  ->  playcanvas-adapter.js
                   (MAIN world, document_start, in this order, all frames)
```

**Why plain scripts, not ES modules.** MV3 content scripts cannot be modules, and a dynamic
`import()` of a `chrome-extension://` URL resolves asynchronously, after the page's first scripts
have run. That would miss the moment both detection hooks depend on: `__THREE_DEVTOOLS__` must
exist before three.js loads, and the PlayCanvas constructor trap before the first `new Application`.
So the three files are ordinary scripts. Chrome runs them in order in the page's own world, and
`core.js` hands its API to the adapters on a non-enumerable, symbol-keyed window property
(`window[Symbol.for('dxr.auto3d.core')]`). There is no bundler and no build step.

| file | owns |
|---|---|
| `core.js` | everything that is not about one engine. **Document state:** one inline-3D session per document, standing down for good when the page asks for `inline-3d` / `immersive-vr` / `immersive-ar` itself, and the per-origin config and kill switch. **Lifecycle:** activate → armed → flip on the page's next draw → per-session-frame → stand. **Sizing:** the side-by-side (SBS) rule (`eyeScale` 0.5, capped at 3072) and the `canvas.width` virtualisation helper. **Rig builder:** the camera rig by default, the display rig on `Ctrl+Alt+P` (see [Rigs](#rigs-camera-by-default-display-on-ctrlaltp)), pushed every frame. **Convergence:** the page's explicit target when it has one, else the estimator (below). **Covers and depth fade:** an `<img>` still of the last mono frame over the canvas for 1.2 s after the layer (the `firstWoven` hold, [woven-canvas rules](../../docs/woven-canvas-rules.md) rule 5), a depth fade in after it and out before a turn-off, and an `<img>` out-cover read back from WebGL for the 3D→2D swap (see [Transitions](#transitions-covers-and-the-depth-fade)). **Turn-off order:** mono frame first, layer released after it is committed (below). **Other:** the HUD, hotkeys, `window.__dxrAuto3D`. |
| `three-adapter.js` | the three.js prototype's own code, unchanged in behaviour. Detection through `__THREE_DEVTOOLS__`, per-instance wrapping of `render` / `setSize` / getters, per-eye render into each half, flat HUD / post passes, render-on-demand replay, reversed-Z |
| `playcanvas-adapter.js` | detects the app, drives the page's camera through the engine's `RenderView` path, resizes the store through `device.setResolution`, supplies bounds from `render` / `model` / `gsplat` components, and applies the gsplat footprint fix |

**Convergence: the page's target first.** When the page says what it is looking at, that is the
convergence distance: the depth, along the camera's axis, of

- three.js: the point of the camera's last `lookAt()`. OrbitControls, MapControls and
  TrackballControls all end `update()` with `this.object.lookAt(this.target)`, so this is their
  `.target`; `Object3D.prototype.lookAt` is wrapped when the first Scene is announced (before the
  page builds its camera and controls). The controls object itself is not reachable (its canvas
  listeners are bound functions), except from a `window.controls` / `orbitControls` /
  `cameraControls` global whose `.object` is the page camera;
- PlayCanvas: `pivotPoint` of an `orbit-camera.js` script, or `focusPoint` of the engine's
  `CameraControls` script, on the camera entity; otherwise the camera entity's last `lookAt()`
  (`GraphNode.prototype.lookAt`, wrapped from `app.root`).

It is used only while the camera is still looking at it (within a quarter of the half-FOV of the
axis) and it is in `[2·near, 0.9·far]`; a stale `lookAt` falls back to the estimator. The target is
followed every frame, eased by 0.25 per frame. The HUD and `state().renderers[].convergenceSource`
say which one is in use: `target`, `estimator`, or `manual` once `Ctrl+Alt+0` / `9` has scaled it
(`convergenceVia` names the target's origin, e.g. `camera.lookAt`).

**The convergence interface.** `core.estimateSubjectDistance(sampler)` takes
`{ cameraPose, viewMatrix?, verticalFov, tanHalfFov?, aspect, near, far, forEachBounds(cb) }`. The
adapter calls `cb(wx, wy, wz, worldRadius)` for each drawable its camera can see, and stops when
`cb` returns `false`. The rule is the prototype's: a sphere that contains the camera is not a
subject. If the camera is outside the rest, the result is the distance to their centre. If it
stands among them, the result is the apparent-size-weighted median depth. The value is clamped to
`[2·near, 0.9·far]` and eased by 0.25 every 30 frames.

**The adapter contract** (hooks the core calls on `st.ad`) is written out at the top of `core.js`:
`unqualified`, `hasCamera`, `depthRange`, `rigFov`, `sampler`, `target`, `beforeActive` /
`afterActive`, `firstDraw`, `redraw`, `restore`, `flipIdle`, `wake`, `describe`, plus `readEye` and
`coverAfterDraw` for the out-cover. The adapter calls back `core.drew(st)` after every draw or replay
on the live store (it starts the no-eyes timer) and `core.takeOutCover(st)` right after a draw when
one is due. A third engine means one new file that implements those hooks.

**Turning off: mono first, release after.** A live canvas that goes back to 2D while it stays on
screen (`Ctrl+Alt+3`, a camera switch, no eyes) does it in this order:

1. the store goes back to its mono size and a mono frame is drawn, **with the layer still bound**
   (three.js: the page's last frame, replayed mono in the same task; PlayCanvas: the engine's next
   tick, reported from `postrender`);
2. the layer is closed and the session ended on the **second** animation frame after that frame
   was drawn, i.e. once it has been committed (at most `releaseMaxMs` 500 ms later, for a page that
   stopped drawing).

The reverse order (release, then draw) was what v0.2.0 did. `layer.close()` reaches the browser on
its own channel, not with the next commit, so the browser can stop weaving while the last
*committed* frame is still the side-by-side pair: shown unwoven, that is the raw-pair flash
([woven-canvas rules](../../docs/woven-canvas-rules.md) §1). The first panel run logged one
`inline-3D withheld ids=[no-identity@…]` 8 ms after a three.js turn-off, which is this window. With
the new order the frames around the switch are either the woven pair or the page's own mono pixels:
in the one frame where a mono store sits under a still-bound layer, its resource has changed, so the
browser cannot join it and shows the page's pixels (mono) rather than weave it. A join-window cover
still up at turn-off stays until the release. Leaving for good (the page asked for inline-3D /
WebXR itself, the canvas or document is going away) still releases at once: the page needs the
session back.

**Re-enabling a page that draws on demand.** `Ctrl+Alt+3` back on asks each adapter for one frame
(`wake`): three.js replays the page's last mono frame through the wrapped renderer, PlayCanvas sets
`app.renderNextFrame`. Without it a render-on-demand page (three.js `webgl_geometry_teapot`,
supersplat-viewer with `autoRender = false`) stayed 2D until the next input.

**No eyes: back to 2D, timed from the first draw (v0.4.0).** With no 2-view frame for `noViewsMs`
(4 s) and no display behind the layer confirmed, the canvas goes back to 2D and retries later. The
timer starts at the first draw or replay on the side-by-side store after activation, not when the
layer is created: a render-on-demand page, or one busy loading, may not draw for a while, and until
the tile has content there is nothing to locate eyes for. Until that first draw there is no timeout;
the join-window cover (which only drops after a stereo frame) keeps the page's own picture up.

## Transitions: covers and the depth fade

Panel-verified with David on 2026-09-27 (three.js `webgl_animation_keyframes`: "works perfect";
PlayCanvas `gaussian-splatting/simple`: "works good too").

**2D → 3D.** The cover over the join window is an **`<img>`**, not a `<canvas>`. A canvas congruent
with the tile was woven with it (weave dumps showed the mono cover as the pair input: each eye got
half of the mono picture, a big double image at go-live); an image stays plain 2D over the tile.
Under the cover the rig is flat (`rampK` 0: both eyes on the page camera, the mono picture). When the
cover drops, a hard cut between two identical pictures, the depth fades in over `rampMs` (500 ms,
smoothstep): `rampK` scales the rig's ipd and parallax factors from 0 to 1. `cfg.coverImg = false`
restores the canvas cover (diagnostics).

**3D → 2D (`Ctrl+Alt+3` off).** The depth fades out to `rampK` 0 first and holds two frames (a rig
drives the NEXT locate). Then the **out-cover** goes over the canvas: one eye of that flat pair, which
IS the mono picture. The mono draw and the layer release (mono first, release after, above) happen
under it, and it is removed once the canvas has re-rastered as a plain 2D layer (6 frames and
150 ms after the release).

**How the out-cover gets its pixels.** `drawImage()` from a canvas with an `XRDisplayLayer` bound
returns nothing on the panel, so an out-cover taken that way only ever showed its CSS background:
the blank frame at 3D→2D. The out-cover is read back with **`gl.readPixels`** of the left eye
(`core.readGlEye`), which does work under a bound layer, but only in the **same task as the draw**:
the drawing buffer is not preserved, and the session frame is a different task from the page's own
draw. So each adapter takes it at its own "frame just drawn" point through `core.takeOutCover()`:
three.js at the end of the wrapped scene render or replay, PlayCanvas on `postrender`. The read
restores every GL binding and pack parameter it touches, and falls back to `drawImage()` with a
console warning if it fails (no context, lost context, an all-zero read). The `<img>` is inserted
only once decoded (`decoding = 'sync'`): inserted earlier, its box paints its background for a frame.

## What each adapter converts, and where it stands down

### three.js (r105+, `WebGLRenderer`)

| Page | Result |
|---|---|
| one `WebGLRenderer`, a `PerspectiveCamera` drawn straight to the screen | **3D** |
| render-on-demand (draws only on input) | **3D**, idle frames replayed |
| reversed-depth renderer (`reversedDepthBuffer: true`) | **3D** (eye projection converted to reversed-Z) |
| extra screen passes after the scene (HUD, overlay) | **3D** scene, flat overlay |
| several viewports in one canvas | flat per viewport |
| post-processing chain (the screen pass is a full-screen quad) | **2D**: needs per-eye render-target twins (next) |
| `WebGPURenderer`, r104 and older, OffscreenCanvas / worker rendering | **2D** / not seen |
| a second renderer in the same document | 2D (one converted canvas per document) |

### PlayCanvas (engine 2.x, WebGL2)

**Finding the app.** Every route below is armed at `document_start`, and the first hit wins:

1. **`window.pc`**, a UMD / editor build: `pc.app`, `pc.AppBase.getApplication()`. The global is
   watched with an accessor, so the moment the engine script assigns it is seen.
2. **`window.app`**, when it is an AppBase: many demos. Polled every 500 ms for 20 s.
   supersplat-viewer no longer uses this route: 1.35.2 does not set `window.app`, with or without
   `exposeGlobals`. It is found through route 3 (verified on the panel, 2026-09-26).
3. **ESM bundles with no global.** The first statement of the AppBase constructor is
   `AppBase._applications[canvas.id] = this`, a plain-object store keyed by the canvas id. The
   adapter watches canvas `id` reads (the `Element.prototype.id` getter, for canvases only) and
   puts a one-shot setter for exactly that key on `Object.prototype`. It stays there for the rest
   of that task and is removed at the next microtask checkpoint. The engine's assignment lands on
   the setter, which hands over `this` (the app) and re-creates the property as an ordinary own
   property, so the engine's store is unchanged.

**Per-eye path.** This is the SDK adapter's recipe (`js/inline3d-splat-playcanvas.js`). The
adapter sets `camera.camera.xrViews = [RenderView, RenderView]`. Each view gets the runtime's
`projectionMatrix`, and a pose of camera **local** × `view.transform`. The local transform is used
because `Camera.updateViewTransforms` composes each view with the camera node's *parent*, so the
eye still equals camera world × `view.transform` (the attach pattern). Each view's viewport is
half of the SBS store. `setXrProperties` gets the fov, aspect, near and far read from the eye
projection, so that LOD and culling see the frustum the views actually have. The views are set on
`prerender`, after the page's update and before the engine syncs the hierarchy. On stand-down,
`xrViews = null`. When there is no `pc` namespace (every ESM app), the adapter builds its own
`RenderView`: the engine's class copied line for line (MIT), on the engine's own `Mat4` / `Vec4`,
reached from live instances. The engine's `XrManager` is never touched.

**Sizing.** The engine sizes the canvas only through `device.setResolution` (`resizeCanvas` and
`RESOLUTION_AUTO`'s per-frame `updateCanvasSize` both call it). While converted, the adapter
records what the page asked for and applies the SBS size instead. `canvas.width` is **not**
virtualised on PlayCanvas: the engine reads it internally (`device.width`, the back-buffer resize
check, `resizeCanvas`'s own compare), so it has to report the real store. With the default
`eyeScale` 0.5, the SBS store *is* the mono size until the 3072 cap, so a page that reads
`canvas.width` sees no change there.

**Gaussian splats.** A side-by-side eye has non-square pixels, and the engine's `gsplatCornerVS`
derives one focal length from the viewport width, which draws every splat at half height. The
SDK's `patchGsplatFootprint` rewrite is applied at `gl.shaderSource`, installed before the app's first
frame, because `ShaderChunks` is not reachable from an ESM app. Square pixels are unchanged by it
(the SDK measured MAE 2.5e-6). The sort and LOD stay centred on the page's camera node; the eyes
are offset from it by a few ipd × m2v.

| Page | Result |
|---|---|
| one enabled camera rendering to the canvas, meshes and/or gsplat | **3D** |
| `autoRender = false` (render on demand) | **3D**. The adapter sets `renderNextFrame` every session frame |
| WebGPU device | **2D**, HUD: `WebGPU device — the prototype drives WebGL2 apps only` |
| two or more cameras render to the canvas (UI camera, picture-in-picture) | **2D**, HUD reason |
| post effects (`camera.postEffects`) or `CameraFrame` / `framePasses` | **2D**, HUD reason (per-eye targets: next) |
| orthographic camera | **2D**, HUD reason |
| the app presents WebXR through `app.xr` | stands down (the immersive path owns it) |
| OffscreenCanvas / worker | not converted |

**What the PlayCanvas adapter cannot see.**
- An ESM app whose canvas id collides with a property that already exists on `Object.prototype`.
  That takes an id such as `constructor` or `toString`.
- An app constructed before `document_start`: never, for a content script.
- An app built on an **OffscreenCanvas in a worker**. There is no canvas id read on the main
  thread, and nothing to weave.
- An ESM app whose AppBase is constructed a second time on the same canvas id. The key is then
  already an own property of `_applications`, so the trap never fires. Only the first app is
  seen, which suits a one-session document anyway.
- Nothing else in the engine is reachable from a bare canvas. The tick is a closure, the device is
  created after the constructor and holds no back-pointer, and input handlers are bound
  functions. If the constructor trap ever stops working (an engine that renames `_applications`,
  or stores apps in a `Map`), the fix is an engine-side hook, not a smarter search. A one-line
  upstream change would do it: `AppBase` firing a `window` event or calling a registered global
  hook at construction, the way three.js announces renderers to `__THREE_DEVTOOLS__`. See the
  integration proposal.

## Try it on the display (Windows box)

**A — in your own DisplayXR Browser (recommended).** `chrome://extensions` → *Developer mode* →
*Load unpacked* → select this folder. Then open or reload a three.js / PlayCanvas page.

**B — a separate profile.** Close **every** DisplayXR Browser window first: a second browser
instance gets no weave slot and stays 2D forever
([displayxr-browser#162](https://github.com/DisplayXR/displayxr-browser/issues/162)). Then run
`launch.cmd [url]` (non-elevated).

Pages to start with:

| Page | What it exercises |
|---|---|
| `https://threejs.org/examples/webgl_animation_keyframes.html` | three.js: a continuous loop, a model on a turntable |
| `https://threejs.org/examples/webgl_geometry_teapot.html` | three.js: render-on-demand (the replay path) |
| `https://threejs.org/examples/webgl_shadowmap.html` | three.js: a reversed-depth renderer |
| the PlayCanvas engine examples browser (`playcanvas.github.io`), a mesh example | PlayCanvas: meshes. The examples browser runs each example in an iframe; the script runs in all frames |
| the same, a gaussian-splatting example | PlayCanvas: gsplat (footprint fix) |
| a supersplat-viewer page with `&webgl` | PlayCanvas: an ESM app found through the canvas-id trap (route 3), `autoRender = false`. Without `&webgl` the viewer picks WebGPU and stays 2D. A standalone copy of the viewer (its built `index.html` served locally) needs the scene's `settings.json` next to it (`./settings.json`); without it the viewer never starts |
| the PlayCanvas engine examples, `loaders/glb` | PlayCanvas: the camera alternates perspective / orthographic every 2 s (3D, then 2D; see below) |

### Hardware verification checklist (for the tester)

1. **It converts.** The console shows `[dxr-auto3d] three.js r… renderer found` or `PlayCanvas app found via …`, then `live on canvas…`.
   The HUD (bottom left) reads `DXR auto-3D ● camera rig · depth 0.30 · conv … · 3D <growing> · flat <small>`.
   `window.__dxrAuto3D.state()` reports `active: true`, the engine, the detection route, `real` =
   the SBS store, and `eye`.
2. **It weaves.** Close each eye in turn: the views must differ. Depth must read sensibly at the
   convergence (objects there sit on the glass).
3. **No raw pair at the switch.** Launch with `--enable-logging --v=1` (`launch.cmd` does), reload,
   and read `%TEMP%\dxr_auto3d_chrome.log` for
   `[DisplayXR] inline-3D withheld N of M weave rects: … ids=[<token>=<why>@<rect> …]`. The `why`
   token is the one to report. `no-identity` during the first ~1.2 s is the window the cover
   hides; `no-identity` after the cover drops means `holdMs` is too short on that box;
   `cross-pass:mono` means an ancestor CSS effect (rule 7); `no-quad` means the canvas is not
   drawing. The line is throttled (the first three, then one in 300), so a missing line proves
   nothing on its own. Do the same at **turn-off** (`Ctrl+Alt+3`): the console logs `layer released
   N ms after the stand (mono frame drawn first)`, and no raw pair may show between the stand and
   the release.
4. **Comfort.** Try `Ctrl+Alt+=` / `-` (depth) and `Ctrl+Alt+0` / `9` (convergence farther /
   nearer), and write down the values that felt right, per page and per rig. Note which convergence
   source the HUD shows (`target` / `estimator` / `manual`). On an object-centric page (a product, a
   model on a turntable) try `Ctrl+Alt+P` (display rig, depth 1.00 by default) and say which rig
   reads better; `Ctrl+Alt+-` on the display rig must flatten the stereo AND damp the look-around
   together.
5. **Stand-down.** Open an SDK sample (for example `samples/splat/`): the HUD must read
   `standing down (the page requested 'inline-3d')`. Press `Ctrl+Alt+3` on a converted page: back
   to 2D at once, the page intact. Press it again, without touching the page: 3D again within a
   second or so, including on render-on-demand pages (`webgl_geometry_teapot`, supersplat-viewer).
6. **Frame rate.** Every converted draw runs twice. Note the page's fps before and after.

## Controls

`Ctrl+Alt+…`: **3** turns it on or off for this site · **P** camera rig / display rig · **=** /
**-** depth of the active rig (×1.25 / ÷1.25, 0.02 to 1) · **0** / **9** convergence farther /
nearer · **8** reset the active rig's depth and the convergence · **D** HUD. Everything is
remembered per origin, and **depth per rig**: camera 0.30, display 1.00 by default, and toggling
the rig brings back that rig's own value. The HUD and `state().depth` show the active rig's depth
(`state().depths` has both). The HUD also shows the rig, the convergence distance and its source,
and counts of stereo / flat / replayed frames.

**Depth is one joint control on both rigs**: it scales the eye separation and the head-motion
parallax together, so less depth flattens the stereo and damps the look-around by the same factor.
On the camera rig that is `metersToVirtual` (it scales both); on the display rig it is
`ipdFactor = parallaxFactor = depth`. When a page is left 2D for
a structural reason (WebGPU, post effects, several cameras), the HUD shows that reason too.

### Rigs: camera by default, display on Ctrl+Alt+P

- **Camera rig (default).** `{type:'camera', verticalFov, convergenceDiopters = 1/d,
  metersToVirtual = depth·d/0.5, ipd/parallax 1}`, attached to the page camera (identity pose).
  It keeps the author's FOV and framing; comfort = ipd × m2v × diopters × 0.5 = `depth`.
- **Display rig (`Ctrl+Alt+P`).** For object-centric scenes, like the P key in the legacy WebXR
  apps. `{type:'display', position (0, 0, −d), identity orientation, virtualDisplayHeight =
  2·d·tan(vfov/2), ipdFactor = parallaxFactor = depth, perspective 1}`, in the page camera's space. The
  canvas becomes a portal on the convergence plane, square to the page camera and exactly as tall
  as the page camera's view there, so what the author framed at the subject is what the portal
  shows, sitting on the glass. The runtime puts the eyes at the viewer's real distance (m2v = portal
  height / physical canvas height), so the FOV becomes the display's own and the stereo is
  scale-invariant. A display rig's comfort number is its `ipdFactor`, so `depth` keeps one meaning
  on both rigs. The far plane is pushed out by however far behind the page camera the runtime put
  the eyes. Declared, never computed: no Kooima in the page.

Defaults (`DEFAULT_DEPTH`, one line at the top of `core.js`, David's call 2026-09-27): **camera rig
0.30**, **display rig 1.00**. Display depth 1 is the physically true portal: natural IPD and full
head parallax. It is also the ceiling, on both rigs: the display rig's factors are `[0, 1]` in the
`XR_DXR_view_rig` contract (the runtime currently accepts more, as a widening it documents as
temporary while validating the rig converters), and a camera-rig depth above 1 breaks the runtime's
comfort rule. So there is no headroom above 1: on the display rig at its default, `=` does nothing
and `-` is the only way to go. A site stored under v0.3 (one depth for both rigs, tuned on the camera
rig) keeps that value for the camera rig; its display rig starts at 1.00. Both depths are scaled by
the transition fade (`rampK`), which is 1 once settled.

### Cameras that switch projection (PlayCanvas `loaders/glb`)

The adapter goes 3D on the perspective camera and 2D on the orthographic one, and the 1.2 s cover
eats most of each 2 s 3D phase. Skipping the cover on the way back to perspective would need the
browser's join to survive the orthographic phase, and it does not: going 2D **ends the session and
closes the layer**. In the browser, ending an inline-3D session clears the document's weave rects
and retracts its 3D demand (browser-pvt patch 0058), so the panel itself drops to 2D after its
300 ms debounce, and the per-target weave state of a canvas that stops appearing is pruned after
30 frames (~0.5 s, patch 0061). The element's identity token does survive (it is derived from the
DOM node, patch 0060), but everything keyed to the live session is gone, so each perspective phase
is a fresh session and a fresh layer, and it keeps the full cover. The harness pins this (case
`b-flip`).

The alternative is a product decision, not a timing fix: keep the session and the layer through
the orthographic phase and draw it flat into both halves (what the three.js adapter already does
for ortho passes). The join then survives and the way back to 3D needs no cover, but the
orthographic phase becomes a flat woven picture (the panel stays in 3D) instead of true 2D.

`window.__dxrAuto3D.state()` reports every canvas seen, which engine drew it, what was converted,
and why the rest were not. `window.__dxrAuto3D.probe()` asks the live layer for `getDisplayInfo()`
and `getRenderingModes()`. Console lines are tagged `[dxr-auto3d]`.

## Testing without a display

`test/` holds a headless harness: real-GPU Chrome through `puppeteer-core`, driven against a
**fake** inline-3D session (`test/fake-xr.js`). The fake provides `isSessionSupported` /
`requestSession('inline-3d')`, an `XRDisplayLayer` that records `setViewRig`, and frames with two
views: identity poses, with an off-axis skew of ±0.1 in `P[8]`. That skew moves every pixel by
0.1 NDC whatever its depth, so the right half must equal the left half shifted by 0.1 × eye width
(**64 px** on a 640 px eye). The scripts are injected with `page.evaluateOnNewDocument` (main
world, before any page script, the same timing as the extension's content scripts) rather than
`--load-extension`, so the pre-split `content.js` can be swapped in for the parity run.

```bash
cd tools/auto3d-shim/test
npm install                      # puppeteer-core only
node deps.mjs                    # three@0.180.0 + playcanvas@2.22.3 into .deps/ (npm pack; local overrides below)
node run.mjs                     # every case; `node run.mjs a a-legacy` for one; KEEP=1 writes out/<case>.png
```

**Engines, and a box with no registry access.** `deps.mjs` fails loudly (non-zero exit, the file
and the override to use) instead of leaving a page that never converts, and `run.mjs` checks the
same five files and the Chrome binary before it starts (exit 2), and fails a case at once, naming
the file, if a page gets a 404 for anything under `/deps/`. Every file can come from a local copy:
`THREE_BUILD_DIR` (`three.module.js` + `three.core.js`), `PLAYCANVAS_MJS`, and for the addons
`THREE_ORBIT_CONTROLS` / `PLAYCANVAS_CAMERA_CONTROLS`, or found next to the first two when they point
into an npm package layout (`<THREE_BUILD_DIR>/../examples/jsm/controls/OrbitControls.js`,
`<PLAYCANVAS_MJS>/../../scripts/esm/camera-controls.mjs`). With all four set, nothing is fetched.

A converting case settles only once the go-live depth fade has finished (`rampK` exactly 1, no ramp
running), so the rig is always sampled at the configured depth.

| case | page | asserts |
|---|---|---|
| `a` | `pages/three-keyframes.html`: keyframe turntable, shadowed floor, flat HUD pass; freezes after 60 frames (replay from then on) | SBS = 2 × eye, the page still sees its mono `canvas.width`, halves differ, 64 px shift, stereo > 0, no flat scene frame after the eyes arrive, rig fields, convergence 8 ± 5 % |
| `a-legacy` | the same page with the **pre-split** `content.js` (commit `84b14f7`) | the same, plus **parity with `a`**: byte-identical frame (MAE 0.000), identical rig and convergence |
| `a-off` | the same page, site switched off | no session requested, nothing converted |
| `b` | `pages/pc-mesh.html`: ESM PlayCanvas, **no globals**, `RESOLUTION_AUTO`, render-on-demand after 60 frames | found through the constructor trap, SBS, 64 px shift, counters, rig, convergence 8 ± 5 % |
| `a-kill` / `b-kill` | three.js keyframes / PlayCanvas meshes, both frozen (render on demand): `Ctrl+Alt+3` while live, then again | back to 2D (PlayCanvas: `xrViews` released), the canvas shows one mono view; **no raw pair after `close()`** in the commit model (below); the **out-cover holds a real picture** (textured, and matching the mono canvas the right way up); on again, **3D again within 4 s** with the page not drawing |
| `a-target` | `pages/three-orbit.html`: real `OrbitControls`, target 5 units away, scene centre 8 | convergence 5 ± 5 %, source `target` on the HUD and in `state()` |
| `b-target` | `pages/pc-orbit.html`: the engine's `CameraControls`, `focusPoint` 5 units away | the same |
| `a-display` | three.js keyframes: `-` on the camera rig, `P`, `-`, `=` `=`, `-`, `P`, `P`, then a reload | camera depth 0.3 → 0.24 (m2v 0.24·d/0.5); the display rig declared (portal at −d, height 2·d·tan(fov/2)) at **its** 1.0 with `ipdFactor = parallaxFactor = 1`; `-` there gives **both** 0.8 and leaves the camera rig at 0.24; `=` twice caps at 1.0; each toggle restores that rig's own depth; HUD + `state().depth` show the active rig's; `localStorage` and a reload give camera 0.24 / display 0.8 |
| `a-migrate` | three.js keyframes with a v0.3 `{depth: 0.5}` pre-seeded in `localStorage` | camera 0.5, display 1.0 |
| `b-late` | `pc-mesh.html?stallMs=2500`: the page draws nothing for 2.5 s once the layer exists; the fake has no eyes until 3.2 s and no display API; `noViewsMs` 1.5 s | converts with ONE layer and no false no-eyes stand-down (the timer starts at the first draw, ~2.5 s in) |
| `b-noviews` | `pc-mesh.html`, no eyes ever, no display API, `noViewsMs` 1.5 s | back to 2D (layer closed) 1.5-2.5 s after the FIRST DRAW, with the reason in the console: the timer still fires |
| `b-flip` | `pages/pc-flip.html`: one camera alternating perspective / orthographic every 2 s | 2D in each ortho phase, 3D in each perspective phase, a fresh session + layer each time with the full cover (the behaviour documented above), no raw pair at any close |
| `c` | `pages/pc-gsplat.html`: `ports_25.sog` (from the gallery repo's `public/bench/`; `SOG_DIR` to override), `window.app` | as `b`, plus the footprint shader patched; convergence = 2.5 bounding radii ± 5 % |
| `d` | the SDK's `samples/splat/?engine=playcanvas&url=/bench/ports_25.sog` | the shim stands down: `foreign` set, no session of its own, nothing converted, the HUD says so |

**The commit model** (`window.__fakeXRTrackCommits`, cases `a-kill`, `b-kill`, `b-flip`). After
every frame's rAF callbacks (in a ResizeObserver callback, which runs after them and before paint)
the fake takes a 128×72 copy of the bound canvas: the frame this document commits. `close()` is
modelled as reaching the browser at once, so the frame committed before it, and the next few, are
what the browser shows unwoven; none may be a side-by-side pair unless the cover is up. It is a
model of the browser, not the browser: it catches an ordering that closes before the mono frame is
committed, and says nothing about the real compositor's timing.

The harness proves the plumbing: detection, sizing, the per-eye matrices, counters, rig numbers,
the convergence estimate and its source, the turn-off ordering, and parity. It cannot prove the
weave, the join timing, or comfort. Those need the display (checklist above).

On Windows the harness uses the installed Chrome (`CHROME=` to override) with ANGLE D3D11.

## Why a renderer shim, not the alternatives

- **Duplicating WebGL commands** (the 3D Vision approach) works for any engine, but it has to guess
  which draws depend on the view: shadow maps, post-processing passes and UI all look alike at the
  GL level. NVIDIA needed per-game profiles for exactly this.
- **Synthesising the second eye from the depth buffer** costs one render, but it leaves holes at
  edges, gives transparent objects and particles the depth of what is behind them, and has no
  meaningful depth under post-processing. The runtime also has no view synthesis by design: the app
  renders every view.
- **Doing either inside Chromium** keeps the same trade-offs and adds a patch to carry on a fork
  that is rebased every month.
- **An engine-level shim** renders real geometry for each eye from the runtime's own views, uses
  only the public inline-3D surface, and can ship the way the immersive shim did (as a component
  extension) once it earns it.

## Verified, and what is not

**On the display (2026-09-23, three.js only, pre-split v0.1.0):** loaded unpacked into the
DisplayXR Browser 154.0.8037.17 on an SR display, `webgl_animation_keyframes` converts and shows.
That was a first look. Depth comfort, flicker at the switch and frame rate have not been assessed
yet.

**On the display (2026-09-26, v0.2.0, Windows Leia panel):** both engines convert at 60 fps and
read well. The findings of that run are what v0.3.0 fixes: re-enabling a render-on-demand page, the
turn-off ordering, `deps.mjs` on Windows, the supersplat-viewer detection route; plus the display
rig and the target-first convergence.

**On the display (2026-09-27, v0.3.0 + the transition fixes, Windows Leia panel, with David):**
2D→3D and 3D→2D are clean on three.js `webgl_animation_keyframes` and PlayCanvas
`gaussian-splatting/simple`; every out-cover is a full picture (4.4-4.7 MB / 1.2 MB data URLs).
Not yet on the panel: the v0.4.0 per-rig depth (display rig at 1.0) and the joint control, and the
no-eyes timer change.

**Headless, v0.4.0, M1 Pro, ANGLE Metal:** every case in the table above passes (0 failures), and
each v0.4.0 case was checked to fail with its fix reverted. The
three.js path renders byte-identical frames before and after the split (case `a`, with the target
source off so the comparison is about the machinery).

**Not verified: needs the display and a human.** That the weave shows 3D for either engine, with
real runtime views. The cover timing against the real join. Whether `depth` 0.3 and the automatic
convergence are comfortable. Frame rate. PlayCanvas on real sites (UMD builds, the examples
browser's iframes, supersplat-viewer). The gsplat sort artefacts from sorting around the page
camera rather than the eyes.

Measured earlier on a weave-less instance, and handled: a canvas with a layer bound is withheld
from the page and never woven (a blank tile), and `getDisplayInfo()` resolves `null` with no
rendering modes, so the script goes back to 2D within ~1.5 s there. `drawImage()` from a bound
canvas also returns an empty image, which is why the cover is a still.

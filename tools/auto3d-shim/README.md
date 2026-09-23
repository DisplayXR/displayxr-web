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
| `core.js` | everything that is not about one engine. **Document state:** one inline-3D session per document, standing down for good when the page asks for `inline-3d` / `immersive-vr` / `immersive-ar` itself, and the per-origin config and kill switch. **Lifecycle:** activate → armed → flip on the page's next draw → per-session-frame → stand. **Sizing:** the side-by-side (SBS) rule (`eyeScale` 0.5, capped at 3072) and the `canvas.width` virtualisation helper. **Rig builder:** `{type:'camera', verticalFov, convergenceDiopters = 1/d, metersToVirtual = depth·d/0.5, ipd/parallax 1}`, pushed every frame. **Convergence estimator,** as an interface (below). **Cover:** a still of the last mono frame, held for 1.2 s after the layer (the `firstWoven` hold, [woven-canvas rules](../../docs/woven-canvas-rules.md) rule 5). **Other:** the HUD, hotkeys, `window.__dxrAuto3D`. |
| `three-adapter.js` | the three.js prototype's own code, unchanged in behaviour. Detection through `__THREE_DEVTOOLS__`, per-instance wrapping of `render` / `setSize` / getters, per-eye render into each half, flat HUD / post passes, render-on-demand replay, reversed-Z |
| `playcanvas-adapter.js` | detects the app, drives the page's camera through the engine's `RenderView` path, resizes the store through `device.setResolution`, supplies bounds from `render` / `model` / `gsplat` components, and applies the gsplat footprint fix |

**The convergence interface.** `core.estimateSubjectDistance(sampler)` takes
`{ cameraPose, viewMatrix?, verticalFov, tanHalfFov?, aspect, near, far, forEachBounds(cb) }`. The
adapter calls `cb(wx, wy, wz, worldRadius)` for each drawable its camera can see, and stops when
`cb` returns `false`. The rule is the prototype's: a sphere that contains the camera is not a
subject. If the camera is outside the rest, the result is the distance to their centre. If it
stands among them, the result is the apparent-size-weighted median depth. The value is clamped to
`[2·near, 0.9·far]` and eased by 0.25 every 30 frames.

**The adapter contract** (hooks the core calls on `st.ad`) is written out at the top of `core.js`:
`unqualified`, `hasCamera`, `depthRange`, `rigFov`, `sampler`, `beforeActive` / `afterActive`,
`firstDraw`, `redraw`, `restore`, `flipIdle`, `describe`. A third engine means one new file that
implements those hooks.

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
2. **`window.app`**, when it is an AppBase: supersplat-viewer with `exposeGlobals`, and many
   demos. Polled every 500 ms for 20 s.
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
| a supersplat-viewer page with `&webgl` | PlayCanvas: `window.app` detection. Without `&webgl` the viewer picks WebGPU and stays 2D |

### Hardware verification checklist (for the tester)

1. **It converts.** The console shows `[dxr-auto3d] three.js r… renderer found` or `PlayCanvas app found via …`, then `live on canvas…`.
   The HUD (bottom left) reads `DXR auto-3D ● depth 0.30 · conv … · 3D <growing> · flat <small>`.
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
   nothing on its own.
4. **Comfort.** Try `Ctrl+Alt+=` / `-` (depth) and `Ctrl+Alt+0` / `9` (convergence farther /
   nearer), and write down the values that felt right, per page.
5. **Stand-down.** Open an SDK sample (for example `samples/splat/`): the HUD must read
   `standing down (the page requested 'inline-3d')`. Press `Ctrl+Alt+3` on a converted page: back
   to 2D at once, the page intact.
6. **Frame rate.** Every converted draw runs twice. Note the page's fps before and after.

## Controls

`Ctrl+Alt+…`: **3** turns it on or off for this site (remembered per origin) · **=** / **-**
depth · **0** / **9** convergence farther / nearer · **8** reset · **D** HUD. The HUD shows the
depth, the convergence distance, and counts of stereo / flat / replayed frames. When a page is left
2D for a structural reason (WebGPU, post effects, several cameras), the HUD shows that reason too.

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
node deps.mjs                    # three@0.180.0 + playcanvas@2.22.3 into .deps/ (npm pack; PLAYCANVAS_MJS / THREE_BUILD_DIR to use local copies)
node run.mjs                     # every case; `node run.mjs a a-legacy` for one; KEEP=1 writes out/<case>.png
```

| case | page | asserts |
|---|---|---|
| `a` | `pages/three-keyframes.html`: keyframe turntable, shadowed floor, flat HUD pass; freezes after 60 frames (replay from then on) | SBS = 2 × eye, the page still sees its mono `canvas.width`, halves differ, 64 px shift, stereo > 0, no flat scene frame after the eyes arrive, rig fields, convergence 8 ± 5 % |
| `a-legacy` | the same page with the **pre-split** `content.js` (commit `84b14f7`) | the same, plus **parity with `a`**: byte-identical frame (MAE 0.000), identical rig and convergence |
| `a-off` | the same page, site switched off | no session requested, nothing converted |
| `b` | `pages/pc-mesh.html`: ESM PlayCanvas, **no globals**, `RESOLUTION_AUTO`, render-on-demand after 60 frames | found through the constructor trap, SBS, 64 px shift, counters, rig, convergence 8 ± 5 % |
| `b-kill` | the same, then `Ctrl+Alt+3` while live | back to 2D, `xrViews` released, the canvas shows one mono view |
| `c` | `pages/pc-gsplat.html`: `ports_25.sog` (from the gallery repo's `public/bench/`; `SOG_DIR` to override), `window.app` | as `b`, plus the footprint shader patched; convergence = 2.5 bounding radii ± 5 % |
| `d` | the SDK's `samples/splat/?engine=playcanvas&url=/bench/ports_25.sog` | the shim stands down: `foreign` set, no session of its own, nothing converted |

The harness proves the plumbing: detection, sizing, the per-eye matrices, counters, rig numbers,
the convergence estimate, and parity. It cannot prove the weave, the join timing, or comfort.
Those need the display (checklist above).

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

**Headless, v0.2.0 (this split), M1 Pro, ANGLE Metal:** every case in the table above passes. The
three.js path renders byte-identical frames before and after the split.

**Not verified: needs the display and a human.** That the weave shows 3D for either engine, with
real runtime views. The cover timing against the real join. Whether `depth` 0.3 and the automatic
convergence are comfortable. Frame rate. PlayCanvas on real sites (UMD builds, the examples
browser's iframes, supersplat-viewer). The gsplat sort artefacts from sorting around the page
camera rather than the eyes.

Measured earlier on a weave-less instance, and handled: a canvas with a layer bound is withheld
from the page and never woven (a blank tile), and `getDisplayInfo()` resolves `null` with no
rendering modes, so the script goes back to 2D within ~1.5 s there. `drawImage()` from a bound
canvas also returns an empty image, which is why the cover is a still.

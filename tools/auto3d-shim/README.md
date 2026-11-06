# auto-3D for existing three.js, PlayCanvas and Babylon.js pages (prototype)

Turns an ordinary, already-published three.js, PlayCanvas or Babylon.js page into a woven glasses-free-3D
window in the DisplayXR Browser, **with no change to the page**: no SDK import, no WebXR, no source
edit. It is a prototype for measuring coverage on real sites, in the same spirit as
`tools/immersive-shim/` (which does the same for WebXR `immersive-vr` pages). It is not a product
and must not ship as one. How it would fold into the browser: [`docs/proposals/auto3d-browser-integration.md`](../../docs/proposals/auto3d-browser-integration.md).

## Architecture: a sentinel, one core, one adapter per engine

The sources are **part files**, each one top-level `function dxr…`, and `build.mjs` (Node, no
dependencies, no bundler: concatenation plus a version stamp) assembles them into `dist/`:

```
dist/auto3d-sentinel.js   (function (cfg, cap) { sentinel.js ... return dxrSentinel(cfg, cap); })
dist/auto3d-core.js       (function (cfg, cap, S) { core.js surface.js guard.js chip.js dev.js
                            three-adapter.js playcanvas-adapter.js babylon-adapter.js ... return dxrCore(cfg, cap, S); })
dist/auto3d-dev.js        (() => { host-dev.js sentinel.js  const CORE = function (cfg, cap, S) {…};
                            dxrSentinel(dxrDevHost(() => CORE)…) })()   <- manifest.json (dev extension)
VENDOR.json               { name, version, sourceCommit, sourceSha256, files: { <f>: { bytes, sha256 } } }
```

The browser vendors `dist/auto3d-sentinel.js` + `dist/auto3d-core.js` **verbatim** and checks them
against `VENDOR.json`: fix here, `node build.mjs`, re-vendor. `node build.mjs --check` fails when the
committed `dist/` is not what the sources build to. The two product files are **expressions**: the
host evaluates the sentinel in the page's main world at document start and calls it with a frozen
`cfg` and a capability object `cap`; the sentinel asks `cap.loadCore()` for the core. Parts hand
each other plain function arguments inside one lexical scope; nothing is put on `window` except a
value-only double-injection marker, `window[Symbol.for('dxr.auto3d')] = true` (the first injector
wins: the dev extension, or the browser's).

```
cfg = { decision: 'allow'|'offer'|'block', depths: { camera, display } (0.02..1), rig: 'camera'|'display',
        convScale (0.05..20, 1 = automatic), dev, engines: { three, playcanvas, babylon }, test }   // frozen
        // engines: an engine set to false is never detected; a missing key means on
cap = { loadCore() -> function, save({ decision?, depths?, rig?, convScale? }), report({ status, engine?, reason? }) }
      // report: 'live' | 'converting' | 'standdown' | 'optout' | 'guard' | 'offer' | 'off' | 'flat' | 'idle' — transitions only
```

**What a page can see of us.** Before an engine is found, exactly four things (the sentinel's
header has the details; `test/cases/sentinel.mjs` `s-cost` checks them on a 2,000-element page with
no engine: no other window key, no other prototype descriptor, no timer, `'pc' in window` false):

1. `window.__THREE_DEVTOOLS__`, a non-enumerable accessor holding an `EventTarget`;
2. `HTMLCanvasElement.prototype.getContext`, wrapped (the only prototype change);
3. `navigator.xr.requestSession`, wrapped;
4. an own, non-enumerable `id` accessor on armed `<canvas>` elements (plus, for the rest of a task
   in which one was read, a one-shot setter for that id on `Object.prototype`), and, for the rest of
   a task in which a WebGL (WebGPU) context was created, a one-shot non-enumerable `_gl` (`_context`)
   setter on `Object.prototype` (the Babylon.js constructor trap, v0.7.0; gone at the next microtask
   checkpoint).

Plus one `MutationObserver` on the document (not page-visible; it arms `<canvas>` elements as they are
added, see R1 below) until an app is found or the first mutation after load + 10 s.

Plus the value-only symbol marker. After an engine is found the core adds what converting needs:

5. per-instance wrappers on the renderer / app (three.js `render` / `setSize` / getters, plus
   `Object3D.prototype.lookAt` wrapped when the first Scene is announced; PlayCanvas
   `GraphNode.prototype.lookAt` and the camera's `xrViews`; Babylon.js observers on each scene
   (`onBeforeRender`, `onAfterRender`, `onActiveCameraChanged`, `onDispose`), the scene's own
   `addCamera`, the scene's `postProcessManager._finalizeFrame`, `TargetCamera.prototype.setTarget`,
   two `dxrEyePass*` shaders in the engine's shader store, and while converted the page camera's
   `cameraRigMode` / `_rigCameras`, two eye cameras in `scene.cameras`, two eye-target post-processes in
   `scene.postProcesses`, and the engine's hardware scaling level while the store is rescaled), and the
   canvas `width` / `height` virtualisation while converted (three.js, and a PlayCanvas page that writes them);
6. during a switch, for ~1.2 s: the cover `<img>` inserted as a **sibling** of the canvas, and the
   canvas's inline `will-change` / `transform` (risk R7: layout-visible while they last);
7. the **chip host**: one element on `<html>` carrying `popover="manual"` and a
   `data-dxr-auto3d-chip` attribute, `position:fixed`, 0×0, in the top layer, with a **closed**
   shadow root (page code sees the host, never its contents). The chip's own input events stop at
   the shadow root, but page **capture-phase** listeners on `window` / `document` still see them;
8. possibly **one** `document.adoptedStyleSheets` entry, a single rule
   (`[data-dxr-auto3d-chip]::backdrop{…transparent…}`), appended only when a page-wide `::backdrop`
   rule would otherwise dim the whole page behind the top-layer chip (risk R9);
9. while a canvas is converted (v0.5.6): the attribute **`data-dxr-auto3d="live"`** on that canvas
   (see [Coexistence with Convert to 3D](#coexistence-with-convert-to-3d-v056)). A page's own
   `MutationObserver` sees exactly one set and one remove per conversion.

`test/cases/chip.mjs` `chip-layout` checks that the page's DOM, attributes, boxes and computed styles
are identical before and after go-live, minus the host and the cover, with item 6 allowlisted and
item 9 asserted on its own (the only attribute added).

**Opt-out.** `<meta name="displayxr-auto3d" content="off">` (name and content case-insensitive,
content trimmed). The sentinel checks it on the first WebGL (or, since v0.6.0, WebGPU) context and when an engine is found:
the core is never loaded, one `{ status: 'optout' }` report, one console line. Inserted later, the
core refuses to activate, and a live canvas goes back to 2D within 30 session frames.

A user `block` outside dev never loads the core (the sentinel stays detect-only, and reports
`{ status: 'off', engine }` once when it finds one). The `requestSession` wrapper stays installed
under block. The dev extension
emulates the host with `host-dev.js` over the page's `localStorage` (the v0.4 behaviour, including
the v0.3 single-depth migration); `window.__dxrAuto3DTestCfg` is read only there, and only in dev.

| file | owns |
|---|---|
| `sentinel.js` | `dxrSentinel(cfg, cap)`: the DisplayXR check, the marker, `S.intrinsics` (built-ins snapshotted before page scripts: `attachShadow`, `showPopover`, `elementsFromPoint`, the canvas `width`/`height` and `Element.id` descriptors), the `navigator.xr.requestSession` wrapper (a page that asks for `inline-3d` / `immersive-*` owns XR; our own requests use `S.xrRequest`), **engine detection** (`__THREE_DEVTOOLS__`, the `getContext` wrap, the PlayCanvas routes incl. the parse-time canvas observer, the Babylon.js `_gl` / `_context` constructor trap and `BABYLON.EngineStore`), the page's `<meta>` opt-out (`S.optedOut()`), `S.settle(canvas)` (a canvas went live: the PlayCanvas search stops unless another canvas has a WebGL context) and `S.disarm()` (the core stands down for good: every trap and poll off, for good), and the **lazy** core: `cap.loadCore()` only when an engine is found (three.js: inside the listener for its first `register` / `observe` event; PlayCanvas: when an app is found; Babylon.js: when an engine is found, inside its constructor on the trap route). On a page with no engine the core is never parsed. |
| `core.js` | `dxrCore(cfg, cap, S)`: everything that is not about one engine. **Document state:** one inline-3D session per document, standing down for good when the page owns XR; `site` (this document's copy of the host's decision, depths, rig, convScale) and `on()`. **Lifecycle:** activate → armed → flip on the page's next draw → per-session-frame → stand; `turnOff(st, reason)` (fade to flat, out-cover, staged stand) shared by the site switch and the frame-rate guard. **Sizing:** the side-by-side (SBS) rule (the SBS store = the element's full device size, each eye half of it, whatever store the page keeps; each axis capped on its own: 3072 wide, and the GL limits; see [Tuning](#tuning-keys-v052)) and the `canvas.width` virtualisation helper. **Rig builder:** the camera rig by default, the display rig on `Ctrl+Alt+P` (see [Rigs](#rigs-camera-by-default-display-on-ctrlaltp)), pushed every frame. **Convergence:** the page's explicit target when it has one, else the estimator (below). **Covers and depth fade:** an `<img>` still of the last mono frame over the canvas for 1.2 s after the layer (the `firstWoven` hold, [woven-canvas rules](../../docs/woven-canvas-rules.md) rule 5), a depth fade in after it and out before a turn-off, and an `<img>` out-cover read back from WebGL for the 3D→2D swap (see [Transitions](#transitions-covers-and-the-depth-fade)). **Turn-off order:** mono frame first, layer released after it is committed (below). **Control:** `ctl` (`status`, `setEnabled(on, {remember})`, `setRig`, `setDepth`, `nudgeFocus(-1\|0\|+1)`, `reset`, `onChange`), shared by the chip and the dev hotkeys, and `notify()`, which fans every change out to the chip, the dev HUD and `cap.report`. Tuning constants (`T`) are overridable only from `cfg.test` in dev. |
| `surface.js` | `dxrSurface(core)`: the per-graphics-API **surface** seam (v0.6.0, see [WebGPU](#webgpu-v060)). `core.surfaces.gl(gl)` / `core.surfaces.gpu({ device, context, flush, alphaMode })` build the object an adapter returns from `ad.surface(st)`: `kind`, `limit()`, `flush()`, `readEye(st, target)`, `readFrame(st, target)`, `async`, `toClip(projGL, out)`. The GL read-back (`readGlEye`) lives here, unchanged |
| `guard.js` | `dxrGuard(core)`: the frame-rate guard (see [The guard](#the-frame-rate-guard-the-gl-clamp-reduced-motion)). Hooks: `draw` (the page's 2D rate, from the top of `considerActivation`; also the re-measure after a trip with no baseline), `onFlip`, `tick`, `tripped` (`statusOf` → `'guard'`), `measuring` (`statusOf` → `'converting'`) |
| `chip.js` | `dxrChip(ctl, S)`: the "3D" chip and its menu (see [The chip](#the-3d-chip)). Uses only `ctl` and `S.intrinsics`; the core calls `frame(st)` per session frame and exposes it as `core.chip` (`__dxrAuto3D.chip()` in dev). While the site is off the core still qualifies a **candidate** canvas (`considerCandidate`) so offer mode has something to offer 3D on |
| `dev.js` | `dxrDev(core, ctl)`, only when `cfg.dev`: the HUD, the Ctrl+Alt hotkeys, `window.__dxrAuto3D` (`state()`, `probe()`, `set()`) |
| `host-dev.js` | `dxrDevHost(loadCore)`: the dev extension's stand-in for the browser host, over `localStorage` |
| `three-adapter.js` | `dxrThree(core)`: the three.js prototype's own code, unchanged in behaviour. Fed by the sentinel's `__THREE_DEVTOOLS__` listener (`observe`, `register`); per-instance wrapping of `render` / `setSize` / getters, per-eye render into each half, flat HUD / post passes, render-on-demand replay, reversed-Z |
| `playcanvas-adapter.js` | `dxrPlayCanvas(core)`: takes the app the sentinel found (`consider(app, how, ns)`), drives the page's camera through the engine's `RenderView` path, resizes the store through `device.setResolution`, supplies bounds from `render` / `model` / `gsplat` components, and applies the gsplat footprint fix |
| `babylon-adapter.js` | `dxrBabylon(core)` (v0.7.0): takes the engine the sentinel found (`consider(engine, how, ns)`), hooks its scenes as they are created, and renders both eyes through the engine's own camera-rig path (two eye cameras on `RIG_MODE_CUSTOM`, as Babylon's WebXR camera does). Sizes the store to the element's device pixels through the engine's hardware scaling level (picking is in store pixels), supplies bounds from the scene's meshes. See [Babylon.js](#babylonjs-7--9x-webgl2-webgl1-webgpu-v070) |
| `build.mjs` | the build above; `--check` for drift |

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
- Babylon.js: an `ArcRotateCamera`'s orbit `target`; a camera's `lockedTarget` (a point or a mesh,
  `FollowCamera` included); otherwise the camera's last `setTarget()` (`TargetCamera.prototype
  .setTarget`, wrapped from the first camera a scene adds: the playground template's
  `camera.setTarget(Vector3.Zero())` is seen).

It is used only while the camera is still looking at it (within a quarter of the half-FOV of the
axis) and it is in `[2·near, 0.9·far]`; a stale `lookAt` falls back to the estimator. The target is
followed every frame, eased by 0.25 per frame. The HUD and `state().renderers[].convergenceSource`
say which one is in use: `target`, `estimator`, `fixed`, or `manual` once `Ctrl+Alt+0` / `9` (the
chip's Focus nearer / farther) has scaled it (`convergenceVia` names the target's origin, e.g.
`camera.lookAt`, or `open scene`).

**Convergence, three tiers** (David's call for open scenes, 2026-09-28):

1. **The page's target** (above), when there is one and the camera is looking at it.
2. **A bounded subject**: the estimator (below) on what is in view, when anything bounded is in view
   (a model, a SplatMesh seen from outside, a mesh among volume pieces: then only the bounded items
   count, the room around them is no subject).
3. **An open scene** (no target, and every sampled bound is a volume around the camera: a World Labs
   / Marble world, a sky + floor): **no dynamic convergence**. A FIXED focus, as legacy WebXR had:
   converge `T.openSceneConvM` (**2**) units in front of the page camera, at **real scale**. The rig
   declares `metersToVirtual = 1` (one scene unit = one metre, so the viewer's own IPD applies) and
   `convergenceDiopters = 1/2`; the user's depth scales the eye separation instead of m2v:
   `ipdFactor = parallaxFactor = rampK × clamp(depth / T.openSceneRealDepth, 0, 1)` with
   `openSceneRealDepth` 0.5, so the default depth 0.5 is the real IPD and 0.25 halves it (never above
   real). Comfort by the camera-rig formula: `ipd × m2v × diopters × 0.5 = 1 × 1 × 0.5 × 0.5 = 0.25`,
   the legacy-WebXR level, whatever the room's size. HUD: `conv 2.00 (fixed)`; the chip's Focus row
   reads `auto (fixed)`.

   **The metric assumption.** The 2 m reads as 2 m only if the scene is in metres (Marble worlds and
   most three.js scenes are). As a sanity check the core still computes the 70th-percentile
   (`T.convRoomPercentile`) apparent-size-weighted depth in view and, once per canvas, logs a console
   note when it is below 0.2 or above 200 units (`the scene may not be metric; use Focus nearer /
   farther`). It does not act on it: **Focus nearer / farther** (`Ctrl+Alt+9` / `0`, or the chip) is the
   escape, and scales the fixed focus at real scale.

   The estimator keeps running every 30 frames, so a subject that appears later (a model that loads
   into the world) takes over (`fixed` -> `estimator`), and back when it leaves the view. The fixed
   focus is constant: it snaps rather than eases. `T.openSceneMode = 'percentile'` restores the 0.5.3
   room rule (below) instead of the fixed focus, for an A/B on the panel:
   `window.__dxrAuto3DTestCfg = { openSceneMode: 'percentile' }` on a dev build.

**The convergence interface.** `core.estimateSubjectDistance(sampler)` takes
`{ cameraPose, viewMatrix?, verticalFov, tanHalfFov?, aspect, near, far, forEachBounds(cb) }`. The
adapter calls `cb(wx, wy, wz, worldRadius, among?)` for each drawable its camera can see, and stops
when `cb` returns `false`. The rule is the prototype's: a sphere that contains the camera is not a
subject. If the camera is outside the rest, the result is the distance to their centre. If it
stands among them, the result is the apparent-size-weighted median depth. `among = true` marks an
item as a piece of a volume that holds the camera (a room-scale splat world fed as its splats in
view). With `estimateSubjectDistance(sampler, out)` and `T.openSceneMode` `'fixed'` (the default),
a scene whose in-view items are all such pieces (or with nothing in view but spheres that hold the
camera) sets `out.open` and the caller uses the fixed focus (tier 3 above); a bounded item among the
pieces is converged on by itself. In `'percentile'` mode the room rule applies whatever the centroid test says — not the median but the
`T.convRoomPercentile` (default **0.7**) percentile of the apparent-size-weighted depths, i.e. the
space the camera looks INTO, not the nearest surface. Why: apparent-size weighting lets the floor /
wall just ahead dominate, so the weighted median lands on it (a Marble world on the panel converged
at 1.62 with the room beyond, "disparity is huge"). With `metersToVirtual ∝ d` (`buildRig`), content
at depth `z` sits at `depth × (1 − d/z)` IPD of disparity: behind the glass it is capped at `depth`
whatever `d` is, so a near `d` packs the whole room into the far band, while a farther `d` spreads it
across the band and costs only crossed disparity `depth × (d/z − 1)` on the nearer share. The key is
dev-overridable (`window.__dxrAuto3DTestCfg = { convRoomPercentile: 0.6 }` on a dev build; 0.5 = the
old median rule). The value is clamped to
`[2·near, 0.9·far]` and eased by 0.25 every 30 frames.

**The adapter contract** (hooks the core calls on `st.ad`) is written out at the top of `core.js`:
`unqualified`, `hasCamera`, `depthRange`, `rigFov`, `sampler`, `target`, `beforeActive` /
`afterActive`, `firstDraw`, `redraw`, `restore`, `flipIdle`, `wake`, `describe`, `surface` (v0.6.0; was `gl`
and `readEye`: everything graphics-API-specific now sits behind it, see [WebGPU](#webgpu-v060)), and
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

**Cover max hold (v0.5.1, risk R6).** The cover normally drops `holdMs` (1.2 s) after the layer, at the
first stereo frame. With a display behind the layer (`displayOk`) but nobody tracked, no stereo frame
ever comes (and the no-eyes timer does not apply, since a display is there), so the cover used to stay
up for good and the chip never appeared. After `coverMaxMs` (5 s) it drops anyway: with no views the
pair under it is flat, i.e. the mono picture; `rampK` stays 0 and the depth fades in from the first
stereo frame. Since v0.5.2 that state is **no display** (a session that never delivered two views
in 5 s is most likely a second browser instance, `XR_ERROR_LIMIT_REACHED`): the chip shows the
outline pill with the tooltip *3D display not available to this window*, and the report is
`{ status: 'flat', reason: 'no-display' }` (never `'live'`) until a two-view frame arrives.

**3D → 2D (`Ctrl+Alt+3` off).** The depth fades out to `rampK` 0 first and holds two frames (a rig
drives the NEXT locate). Then the **out-cover** goes over the canvas: one eye of that flat pair, which
IS the mono picture. The mono draw and the layer release (mono first, release after, above) happen
under it, and it is removed once the canvas has re-rastered as a plain 2D layer (6 frames and
150 ms after the release).

**How the out-cover gets its pixels.** `drawImage()` from a canvas with an `XRDisplayLayer` bound
returns nothing on the panel, so an out-cover taken that way only ever showed its CSS background:
the blank frame at 3D→2D. The out-cover is read back with **`gl.readPixels`** of the left eye
(`readGlEye`, the WebGL surface in `surface.js`; on WebGPU a GPU copy of the current texture, see [WebGPU](#webgpu-v060)), which does work under a bound layer, but only in the **same task as the draw**:
the drawing buffer is not preserved, and the session frame is a different task from the page's own
draw. So each adapter takes it at its own "frame just drawn" point through `core.takeOutCover()`:
three.js at the end of the wrapped scene render or replay, PlayCanvas on `postrender`. The read
restores every GL binding and pack parameter it touches, and falls back to `drawImage()` with a
console warning if it fails (no context, lost context, an all-zero read). The `<img>` is inserted
only once decoded (`decoding = 'sync'`): inserted earlier, its box paints its background for a frame.

## What each adapter converts, and where it stands down

### three.js (r105+ `WebGLRenderer`; r178–r186 `WebGPURenderer`)

| Page | Result |
|---|---|
| one `WebGLRenderer`, a `PerspectiveCamera` drawn straight to the screen | **3D** |
| render-on-demand (draws only on input) | **3D**, idle frames replayed |
| reversed-depth renderer (`reversedDepthBuffer: true`) | **3D** (eye projection converted to reversed-Z) |
| extra screen passes after the scene (HUD, overlay) | **3D** scene, flat overlay |
| several viewports in one canvas | flat per viewport |
| post-processing chain: the scene into a render target, full-screen passes, a final pass to the screen (EffectComposer, pmndrs postprocessing, a page's own) | **3D** through per-eye render-target twins (below). Harness case `e-postfx`; **not yet seen on the panel** |
| a camera the page frames with `setViewOffset` and keeps (a lens shift, a crop zoom: `visual-learning.app/sandworm`, `/strandbeest`, `/robotic-bee`), through a chain or straight to the screen | **3D** since v0.6.3: the view window is carried into each eye's projection (see [view windows](#view-windows-setviewoffset-v063)). Harness cases `e-postfx-view0`, `e-postfx-shift`, `e-postfx-crop`, `e-direct-shift`. Before: a chain stayed 2D (`not converting … the screen camera is not a PerspectiveCamera`), and a direct draw converted but never drew a stereo frame |
| a chain whose scene pass sets `setViewOffset` for that draw only (TAA / SSAA jitter) | **2D**, reported `flat` with `the scene pass jitters camera.setViewOffset (TAA / SSAA) — not split`. Harness case `e-postfx-jitter` |
| a chain whose camera keeps a sub-pixel jitter set across frames (a page's own TAA that never clears it) | **2D** since v0.6.4, the same `flat` reason; a live canvas that starts it stands down. Harness cases `e-postfx-taa`, `e-postfx-taa-late`, `e-postfx-taa-short`, `e-postfx-taa-half`. Before (v0.6.3), it converted and froze once the accumulation settled (#226) |
| a camera whose `setViewOffset` moves by sub-pixel steps along one axis, turning back often (a lerped mouse parallax, a spring's tail, an idle bob) | **3D** since v0.6.5: framing, not jitter. Harness cases `e-postfx-bob`, `e-postfx-spring`, `e-postfx-parallax`. In v0.6.4 it was taken for jitter within 8 frames and stayed 2D for good (#231) |
| a chain that flips its picture left-right (a pass sampling `1.0 - vUv.x`: `visual-learning.app/sandworm`) | **3D** since v0.6.3, each eye drawn mirrored so that the page's own flip gives the right pair (see [mirroring chains](#chains-that-mirror-their-picture-v063)). Harness cases `e-postfx-mirror`, `-mirror-eyes`, control `-mirror-ctl`. Before, the pair came out pseudoscopic (seen on the panel) |
| `WebGPURenderer` r178–r186, WebGPU backend or the WebGL2 fallback (`forceWebGL`, or no adapter) | **3D** since v0.6.1 (see [three.js WebGPURenderer](#threejs-webgpurenderer-v061)); before, 2D with `WebGPURenderer — the prototype drives WebGL renderers only` (v0.5.7) |
| `WebGPURenderer` + three's `PostProcessing` (TSL `pass(scene, camera)` chains) | **2D**, reported `flat` with `WebGPU PostProcessing — not split yet …`. Harness case `three-webgpu-postfx` |
| `WebGPURenderer` of another revision (r177 and older never announce it; r187+ are unverified), or an object without the common `Renderer` API | **2D**, reported `flat` with the reason (`WebGPURenderer r190 — the driver is verified on r178–r186 only`). Nothing on the renderer or its canvas is touched. Harness cases `p-webgpu`, `p-webgpu-api` |
| r104 and older, OffscreenCanvas / worker rendering | **2D** / not seen |
| a second renderer in the same document | 2D (one converted canvas per document) |
| Spark Gaussian splats (`@sparkjsdev/spark` 2.x, World Labs worlds) | **3D** (below) |

**Spark (World Labs' splat renderer).** Spark draws inside the page's own
`renderer.render(scene, camera)`: a `SparkRenderer` is a `THREE.Mesh` in the scene, and its
`onBeforeRender` regenerates the splat accumulator for the camera it is given and starts an async
sort (GPU readback + worker), **once per renderer frame** (`renderer.info.render.frame`). Its splat
shader reads the camera's `projectionMatrix` as is, so the eyes' off-axis frusta (and reversed-Z)
pass straight through. Its pixel sizes (the `renderSize` uniform: the projection-to-pixel focal,
the low-pass filter, the pixel-radius limits, the LoD's pixel-scale limit) come from
`getDrawingBufferSize()`, which the adapter answers with the page's mono size to every other
caller. Since v0.5.2 the eye is sized from the element's device pixels, so the eye is not that mono
size (Spark's hello-world: pixel ratio 1 on a 2.5× panel); **since v0.5.4 a call made from inside a
`SparkRenderer`'s `onBeforeRender` during an eye draw is answered with the EYE** (`eyeW × eyeH`,
the viewport it draws into, as three's WebXR path gives Spark its per-view size). `SparkRenderer`s
are found among the scene's direct children (where Spark's examples and its auto-created one put
it); one nested deeper keeps the mono answer. Harness: the `spark` cases assert that Spark's
`renderSize` during a stereo frame equals the eye. The one change it needed is engine-generic: **the two eye
renders of a pair are one renderer frame** (the adapter restores `info.render.frame` between the
eyes), as a three WebXR frame is. Counted per eye, Spark regenerated and re-sorted twice per frame
and its single sort order ping-ponged between the eyes' viewpoints (case `spark-eyes` measures 2
updates, 1 regenerate and 1 sort per frame on a static scene without it; 1, 0 and 0 with it). Both
eyes now share one sort, made from the left eye's viewpoint, which is what Spark does for its own
WebXR (one sort for both views). Exact per-eye order would need a second `SparkRenderer` for the
right eye (`SparkRenderer.sparkOverride` during that eye), at twice the generate + sort cost: not
done. **Convergence on splats.** A `SplatMesh` is a `THREE.Object3D`, not a mesh: no geometry
bounds, so the estimator used to miss it and a Spark page with no target fell back to its default
distance (hello-world: `conv 5.00 (estimator)`). The three adapter now recognises it (duck-typed:
`forEachSplat` + `getBoundingBox` + `numSplats`) and samples its splats itself. Spark's own
`getBoundingBox()` walks every splat per call, so the adapter reads <= 50k centres through
`splats.getSplat(i)` (packed / ext stores) or `forEachSplat` (a paged LoD world), once per splat
count (a streaming world at most once a second, and at most 5 % of the time), caches them per mesh
and applies `matrixWorld` per call. From **outside**, the mesh is one sphere (centroid of the
centres, 98th-percentile radius so a capture's floaters do not inflate it) and the camera converges
on its middle, as PlayCanvas's gsplat AABB does. From **inside** (a World Labs / Marble room, whose
sphere holds the camera and would be dropped), the mesh is fed as its <= 1500 sampled splats in view,
each a sphere of its own scale, flagged `among`: an open scene, so the fixed 2 m focus at real
scale applies (tier 3 above); with `T.openSceneMode` `'percentile'`, the 70th percentile
(`T.convRoomPercentile`) of their apparent-size-weighted depths: the glass sits inside the room, not
on the floor in front of it. The `SparkRenderer` (an instanced quad) is skipped.
The target (`camera.lookAt`, `OrbitControls`) still wins when there is one.

**Post-processing chains (three.js).** Each eye needs its own copy of the whole chain, so the
adapter duplicates every chain draw at the moment the page makes it:

- **Seed.** A draw with the page camera into a target shaped like the canvas (same aspect, at least
  half its size, not a cube / 3D / array target) starts the chain. The left eye
  draws into the page's target, the right eye into a **twin** (`rt.clone()`, kept the target's size,
  viewport and scissor). The aspect test is what keeps a PMREM / cube-face draw (square camera,
  atlas-shaped target) and a picking draw (tiny target) out of it.
- **Chain draws.** A draw that writes a chain target, or whose materials sample a chain texture
  (uniform values, uniform arrays, `map` & co., the depth texture), runs twice. For the right eye the
  target is the twin, and every chain texture it samples is swapped to the twin's for that one draw,
  then put back. Only small objects are scanned (a full-screen quad, or a scene holding a few
  meshes), so a scene draw never pays for it.
- **The screen pass** that samples the chain runs once per eye, into its half.

Because each draw is duplicated as it happens, a material whose uniforms the page rewrites between
passes (a two-pass blur on one material, as `UnrealBloomPass` does) is right for both eyes, and a
temporal effect gets a history per eye (its history target is a chain target too). Clears of a
chain target clear its twin. Idle frames replay the final screen passes, sampling each eye's own
chain. Twins are disposed when the canvas goes back to 2D. Cost: every chain pass runs twice, at
the page's own target sizes. A page qualifies for this path when a frame draws the scene into such a
target and then a non-perspective pass to the screen, with no perspective draw to the screen in the
same frame. When a frame draws its scene into a target that is not taken as a seed, the 2D line says
why (v0.6.3): `not converting canvas yet: the screen camera is not a PerspectiveCamera (the scene went
into a render target first, but not as a post chain's input: target 320x180 is under half the
canvas's 1280x720 px)`. Harness case `e-postfx-miss`.

#### View windows (`setViewOffset`, v0.6.3)

`visual-learning.app/sandworm` (#221) frames its camera with `setViewOffset`. At rest it calls
`setViewOffset(w, h, 0, h/2 − centre, w, h)`, a lens shift that centres the subject between the HUD
panels. `__STAGE.setCrop(z, …)` makes it a crop zoom. Its EffectComposer chain stayed 2D because a
seed with a view offset was refused, a rule meant for TAA jitter.

Now the view is the page's framing, carried into each eye. three draws a view as a sub-window of the
camera's image plane. In NDC that window is a 2D scale + offset, so in clip space (`x' = a·x + b·w`,
`y' = c·y + d·w`, x / y rows only) it applies to the runtime's off-axis eye projections as is. This
equals three r180's `updateProjectionMatrix` to 4e-16, on symmetric and off-axis frusta. Both eyes
get the same window. The convergence plane keeps zero disparity, and a crop zoom magnifies the
disparity with the picture, as zooming into a stereo photo does: `e-postfx-crop` asserts the pair
shift doubles. The direct path (`isMainPerspective`) and the chain path (`isSeed`) both take it.

TAA and SSAA also use `setViewOffset`. Those chains stay 2D: TAA stops drawing the scene once its
accumulation completes, so the eyes would freeze on the held frame while the head moves. A jitter is
told from framing in two ways.

- **Set for the draw only.** three's `TAARenderPass` and `SSAARenderPass` set a sub-pixel jitter for
  the scene draw and clear it afterwards. A view cleared by the end of the frame's task is jitter, and
  so are several views of one camera in one frame.
- **Left set and moved (v0.6.4, #226, from the #222 review).** A page's own TAA may never clear its
  offset and only move it, so the view reaches the end of every frame. `viewTrend` keeps the view as
  it stands at the end of each frame, in the scene target's pixels (the units a TAA jitters in)
  whatever units the page passes. A run of sub-pixel steps (< 1 px) that stays within 1.5 px and turns
  back at least twice on **both** axes is jitter. A TAA jitters both axes, and Halton and random jitter
  turn back almost every frame, so a TAA is caught on its 4th to 6th sample. Everything else is framing:
  - a view unchanged since the last frame;
  - a move of 1 px or more (a shift, a cut);
  - a new window size (a zoom);
  - sub-pixel steps that keep one direction for 8 frames (a slow pan, `e-postfx-pan`);
  - sub-pixel steps along one axis, however often they turn back (v0.6.5, #231, from the #227 review):
    a lerped mouse parallax (`e-postfx-parallax`), a spring's tail (`e-postfx-spring`), an idle bob
    (`e-postfx-bob`). v0.6.4 asked for the turns on one axis only, so each of these was taken for jitter
    within 8 frames, and the verdict is for good.

  Two cases came out of a second look at the first cut, which took 8 frames that turned back 3 times
  and measured in drawing-buffer pixels. A TAA that settles after fewer than 8 samples and stops
  drawing the scene converted and stayed live (`e-postfx-taa-short`). On a half-size scene target, the
  jitter's ±0.5 target px is ±1 buffer px: its steps reset the run as moves, so it converted
  (`e-postfx-taa-half`).

Jitter leaves the canvas `flat` with the reason. This is sticky for that renderer, and a converted
canvas that starts jittering stands down (`e-postfx-taa-late`).

A chain whose seed has a view offset qualifies once a frame has ended with the view still set and
`viewTrend` says framing. A steady view takes 2 frames; a sub-pixel pan takes 8. A page that stops
drawing before then qualifies 1 s after its last frame. It turned back at most once before it
stopped, so it is not taken for jitter. A TAA of 3 samples or fewer is too short to tell from a nudge,
until its next run of samples carries on from the last; since v0.6.5, so is a 4-sample one on some
Halton phases. A 2-D random shake that decays below a pixel can trip the rule; it cannot be told from
a random-sample TAA. The rule also keeps a
page that sets and clears a framing view around every frame 2D, which was the behaviour before v0.6.3
anyway.

The convergence estimator and `rigFov` still use the camera's full, unwindowed frustum. For a
lens shift that changes nothing. For a crop zoom, the estimator also counts bounds outside the crop.

#### Chains that mirror their picture (v0.6.3)

`visual-learning.app/sandworm`'s chain has a ShaderPass that flips the picture left-right:
`texture2D(tDiffuse, vec2(1.0 - vUv.x, vUv.y))`. Converted, each eye's image went through that flip.
That inverts its disparity, so the pair read as pseudoscopic on the panel. `three-keyframes` and
`webgl_postprocessing_unreal_bloom` read right on the same panel.

**The fix.** Flipping the screen is the same as drawing through the camera C·S, with
S = diag(−1, 1, 1). So, for a mirroring chain, the seed draws each eye as S·E·S with the projection
S·P·S: the eye's x offset and the frustum's x skew are negated. The page's own flip then turns that
into eye E of C·S, head motion included. Swapping the halves instead would fix a still pair but
invert the look-around.
- Order in `eyeProjection`: S·P·S first, then the view window, then the depth conversions.
- The display rig's pivot offset stays in the page camera's own axes.

**How it is found (`probeMirror`).** The probe looks at the picture, so it works however the page
mirrors: a pass's UVs, a flipped quad.
- **What is compared.** In a mono chain frame, two draws are made again, each into a 192-px RGBA8
  target of the shim's own: the chain's screen pass that was just drawn, and the scene by the page
  camera. The same 9 rows of the two are compared, each reduced to 64 bins and high-passed (minus a
  ±6-bin moving average). The shim's targets are always readable; the page's half-float or MSAA ones
  may not be.
- **Never the canvas.** The first version read the drawing buffer instead. On the panel it never
  reached a correlation (`mirrorCorr` null), where the same page decided on its first ask headless.
- **The main seed.** On the panel, sandworm seeded three targets a frame with the page camera: the
  scene, then two overlay scenes of one child each (points / lines, nothing in view). The probe drew
  the last one (`2 calls, 0 triangles, luminance 189..189`), found no structure, and fell back to
  not mirrored. Each seed now records what its own draw drew (triangles + points + lines). The one
  that drew the most is the frame's `main` seed, and the probe, the convergence estimator
  (`st.lastScene`), the mono replay and the flip all use it. Harness case
  `e-postfx-mirror-overlay`.
- **Why high-pass.** Compared raw, the sandworm page's vignette, grading and light gradients
  (left-right symmetric) matched its scene as drawn almost as well as mirrored (r 0.6 vs 0.8).
  High-passed, over its whole tour, as drawn stays near r 0 and mirrored reads 0.4–0.9; as drawn
  never won.
- **Deciding.** A reading that wins with r > 0.4 by 0.25 decides. A blank or ambiguous frame is asked
  again, at most 4 times a second. The page qualifies only once there is a decision.
- **Fallback.** Still undecided 3 s after the first ask means not mirrored, which is how every chain
  was drawn before, so a page that drew one frame and stopped still converts.
- **Cost.** Two extra 192 × 108 draws (the scene and one full-screen pass) and two reads per ask,
  usually one ask. The sandworm page decides on its first chain frame: r 0.88 mirrored vs 0.01 as
  drawn.
- **Diagnostics.** `state()` reports `chainMirror`, `mirrorCorr` ([as drawn, mirrored]), `mirrorAsks`
  and `mirrorWhy`, which says how the last ask ended. A blank frame names what each draw drew
  (calls, triangles, luminance range) and the frame's seeds.
- **Switches.** `chainMirror` is test only. `false` turns the probe off. `'force'` draws every chain
  mirrored whatever the probe found, live from the console with
  `__dxrAuto3D.set('chainMirror', 'force')`. That is how the panel confirmed the eye conjugation
  before the probe was fixed.

### PlayCanvas (engine 2.x, WebGL2 and WebGPU)

**Finding the app** (the sentinel's job; the first hit wins, and the core loads only then):

1. **Globals**: `window.pc.app`, `pc.AppBase.getApplication()`, `window.app` (when it is an
   AppBase). Searched in the microtask after the document's first WebGL `getContext`, at
   `DOMContentLoaded` / `load`, then every 500 ms, 40 times (once per document). There is no
   `window.pc` accessor, so `'pc' in window` stays false. supersplat-viewer 1.35.2 sets no
   `window.app`; it is found through route 2 (verified on the panel, 2026-09-26).
2. **ESM bundles with no global.** The first statement of the AppBase constructor is
   `AppBase._applications[canvas.id] = this`, a plain-object store keyed by the canvas id. The
   sentinel puts a **per-instance** `id` accessor on each candidate canvas; a read of it puts a
   one-shot setter for exactly that key on `Object.prototype`, for the rest of that task (removed
   at the next microtask checkpoint). The engine's assignment lands on the setter, which hands
   over `this` (the app) and re-creates the property as an ordinary own property, so the engine's
   store is unchanged. The constructor reads the id **before** it creates the context, so a canvas
   is armed at `readystatechange → interactive` (every `<canvas>` in the DOM, before deferred and
   module scripts run) and on its first WebGL or WebGPU `getContext`. A trap comes off once an app is found,
   on a `'2d'` context, or 10 s after `load`. (v0.4 wrapped `Element.prototype.id` instead: every
   element's id read paid for it.)

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
check, `resizeCanvas`'s own compare), so it has to report the real store. Since v0.5.2 the eye is
sized from the element's device pixels, so the SBS store is the element's device size (3072 cap), larger than the mono store on a page that renders below device resolution:
page code that reads `canvas.width` directly sees the SBS width while converted (the engine's own
getters are what PlayCanvas apps use).

**A page that writes `canvas.width / height` itself** (v0.6.2). supersplat-viewer 1.37 sets
`app._allowResize = false` and sizes the canvas in its own `resizeCanvas` on the app's `framerender`
event, by assignment, whenever `canvas.width` differs from its size: on a converted canvas, every
frame (the SBS store is narrower than its own wherever the 3072 cap applies: 3840 px at 250 % on the
panel). `device.setResolution` never sees it. So while converted the adapter puts instance accessors
on the canvas: reads stay **real** (the engine reads `canvas.width`), and a write the adapter does
not make itself is recorded as the page's size (`st.L`), the SBS store kept (re-sized only when the
element's size gives another SBS size). The accessors come off at stand-down, after the mono store
is put back. Without them the viewer pulls the store back to its own size every frame (control
`ssv-webgl-trap-ctl`). `state()` counts the writes (`pageSizeWrites`).

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
| WebGPU device | **3D** since v0.6.0 (see [WebGPU](#webgpu-v060)); before, 2D with `WebGPU device — the prototype drives WebGL2 apps only` |
| two or more cameras render to the canvas (UI camera, picture-in-picture) | **2D**, HUD reason |
| `CameraFrame` (the engine's post chain: SSAO, TAA, bloom, DOF, grading, vignette, fringing, sharpening) | **3D** since v0.6.2, the whole chain per eye (see [CameraFrame](#playcanvas-cameraframe-v062)); before, 2D with `CameraFrame / frame passes on the camera — needs per-eye targets (next)` |
| legacy post effects (`camera.postEffects`), or `framePasses` that are not one `CameraFrame` | **2D**, HUD reason |
| the page sizes the canvas by writing `canvas.width / height` itself (supersplat-viewer) | **3D** since v0.6.2: the writes are recorded as the page's size, the store stays side by side (below) |
| orthographic camera | **2D**, HUD reason |
| the app presents WebXR through `app.xr` | stands down (the immersive path owns it) |
| OffscreenCanvas / worker | not converted |

**What the PlayCanvas adapter cannot see.**
- An ESM app, with no global, on a canvas **created by script** after the document became
  `interactive` (`document.createElement('canvas')` then `new Application(canvas)`): its id is
  read before its context exists, so no trap is armed in time. It stays 2D and the sentinel says so
  in one console line when its globals search ends (~20 s; harness case `s-pc-dyn`). Closing it
  needs a parse-time `MutationObserver` (a cost on every page) or the engine-side hook below.
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

### Babylon.js (7+ / 9.x; WebGL2, WebGL1, WebGPU) (v0.7.0)

**Finding the engine** (the sentinel's job; the core loads only then):

1. **The constructor trap (no global needed: ESM bundles).** The `ThinEngine` constructor assigns
   `this._gl = canvas.getContext('webgl2', …)`; `WebGPUEngine.initAsync` assigns
   `this._context = canvas.getContext('webgpu')`. The sentinel's `getContext` wrapper arms a
   one-shot, non-enumerable `_gl` (`_context`) setter on `Object.prototype` for the rest of that task
   (removed at the next microtask checkpoint). The engine's
   assignment lands on it; the setter re-creates the property as an ordinary own data property (the
   engine's `_gl` is then exactly what it would have been) and, when its receiver is a Babylon engine
   (`runRenderLoop`, `scenes`, `getRenderWidth`, `onNewSceneAddedObservable`), hands it over. Any other
   object that assigns `_gl` / `_context` in that task gets an ordinary own property, as it would have
   without us. The core loads inside the engine constructor, before the page has a scene.
2. **Globals (UMD pages, the CDN build).** `BABYLON.EngineStore.Instances`, in the same globals
   search as PlayCanvas's (the microtask after the first WebGL context, `DOMContentLoaded` / `load`,
   then every 500 ms, 40 times). It finds an engine the trap cannot: one built on a WebGL context the
   page created itself in an earlier task (`new Engine(gl)`, harness case `bjs-global`).

The adapter hooks every scene of the engine (`engine.scenes`, then `onNewSceneAddedObservable`):
`onBeforeRender` / `onAfterRender` (the frame hooks), `onActiveCameraChanged`, `onDispose`, and the
scene's own `addCamera` (to wrap `TargetCamera.prototype.setTarget` before the page's setup calls it).

**Per-eye path: the engine's camera rig.** This is how Babylon's own WebXR camera renders two views,
so the engine already knows how to draw a camera with rig cameras: `Scene._processSubCameras` renders
the scene once per rig camera, into its viewport. While converted, the page camera gets
`cameraRigMode = RIG_MODE_CUSTOM` (22: no rig maths of the engine's own) and two eye cameras in
`_rigCameras`:
- **The eye cameras** are instances of the engine's base `Camera` class, reached from the page
  camera's prototype chain (`getClassName() === 'Camera'`; an ESM page gives us no namespace), added
  to the scene as WebXR's are. Viewport `(0, 0, 0.5, 1)` / `(0.5, 0, 0.5, 1)`.
- **Projection:** frozen (`freezeProjectionMatrix`) on a matrix of their own, rewritten in place.
- **View:** recomputed on every `getViewMatrix()` from the page camera's CURRENT world matrix, so a
  camera the page moves in `onBeforeRender` (after `camera.update()`) is followed in the same frame.
- **Change detection:** a rewrite that changes a value bumps the matrix's `updateFlag`
  (`markAsUpdated()`); the scene's transform cache and every effect's uniform cache key on it.
- **Before the first 2-view frame** both eyes get the page camera's own view and projection: the
  flat picture, never a blank tile.

What the engine then does per eye on its own: shadow maps, render targets and the scene's render
target textures, a fullscreen GUI (a layer: flat per eye), utility layers (gizmos:
`UtilityLayerRenderer` swaps the rig cameras' scene), and post-processes (the page camera's chain is
cascaded to the eye cameras by `_cascadePostProcessesToRigCams`; each eye runs it at the canvas's
size into its half, as Babylon's side-by-side stereo cameras do). Stand-down puts the camera's rig
mode back and disposes the eye cameras (their post-process list emptied first: never the page's).

**Handedness and depth conventions.** The runtime's poses and projections are GL's (right-handed, the
eye looks down −Z, clip z −1..1). Babylon is left-handed unless `scene.useRightHandedSystem`. With
H = diag(1, 1, −1):
- eye world = camera world × H × pose × H (for a right-handed scene, H is the identity);
- eye projection = P × H, then the engine's own conventions: `useReverseDepthBuffer` negates the z
  row (Babylon swaps near and far), and a half-z-range engine (`isNDCHalfZRange`: WebGPU) maps the z
  row to 0..1 (z := (z + w) / 2);
- the core's `eyePose` (the display rig's pivot) and estimator get the camera's world × H (the
  runtime's camera convention).

**Sizing: the element's device pixels, through the engine's hardware scaling level.** The side-by-side
store is the element's device size, each eye half of it (the core's rule), but reached UNIFORMLY through
the engine's own hardware scaling level (`_hardwareScalingLevel` = the page's level / s, then the
engine's `resize()`), not by sizing a store the engine does not know about. Babylon picks in store
pixels (`CreatePickingRayToRef` divides the pointer's CSS px by the hardware scaling level, against
`getRenderWidth()`), so the store must stay what `resize()` makes of the level; then picking stays exact.
- **Why.** Babylon's default (`adaptToDeviceRatio` false) renders at CSS pixels. On the panel
  (2026-11-06) the default playground converted at its own store, `SBS 636x495 (eye 318x495)`: heavy
  aliasing, and the sphere read flat (its relief is a pixel or two of disparity at that size). The
  same page at DPR 2 in the harness (`bjs-dpr2`) now converts at 2560 × 1440 for a 1280 × 720 CSS
  canvas, hardware scaling 0.5, and `scene.pick` at the canvas centre still hits the sphere there.
- **Never below the page's own density;** capped by the zero-copy width (`maxSbsWidth`, 3072) and the
  context's limits the same way (uniformly: the eye's aspect is kept, where the core caps each axis on
  its own). Harness case `bjs-cap`: 1024 × 576 from 1280 × 720.
- **A fullscreen GUI laid out in pixels** (an `AdvancedDynamicTexture` on a scene layer, without
  `adjustToEngineHardwareScalingLevel` or an ideal size) keeps the page's density: its controls are
  sized in store pixels and would shrink by the same factor (`bjs-gui`). State: `pixelGui`.
- **A page that sizes its store itself** (not `engine.resize()`: store ≠ CSS size / hardware scaling
  level at go-live) is left as it is. State: `followsResize`.
- While scaled, the page's own `setHardwareScalingLevel()` is recorded (an own method on the engine for
  that time) and re-scaled; stand-down puts the page's level back and resizes. `state()` reports
  `scale` (× the page's density) and `hwScale`.

**Pages that stop drawing.** A page whose render loop stopped (render on demand) for two session
frames gets the scene re-rendered: `scene.render(false, true)` (cameras not updated, animations not
advanced; the page's `onBeforeRender` observers do run, which is why it is used only then). On WebGPU
the replay is bracketed by `engine.beginFrame()` / `endFrame()`: the engine submits only there.
Re-enabling, flipping from idle and the mono frame after a stand-down use the same replay, deferred
to the next animation frame and skipped when the page drew meanwhile (never from inside a render).

**WebGPU.** The same rig. The surface is the device and canvas context (`engine._device`,
`engine._context`, read live); its flush is the engine's own `flushFramebuffer()` (it ends the
current pass and starts new encoders, so the rest of the frame goes on), so the out-cover read in
`onAfterRender` sees this frame. The engine configures the canvas with `COPY_SRC`. Harness cases
`bjs-gpu`, `bjs-gpu-kill`. Not yet seen on the panel.

| Page | Result |
|---|---|
| one scene, one active camera (ArcRotate / Universal / Free / Follow / any `TargetCamera`), drawn to the whole canvas | **3D**, at the element's device pixels |
| `scene.useRightHandedSystem`, `useReverseDepthBuffer` | **3D** (harness `bjs-rh`, `bjs-est-rev`) |
| a fullscreen GUI (`AdvancedDynamicTexture`), utility layers (gizmos) | **3D** scene, the GUI flat per eye (`bjs-gui`; at the page's own density when laid out in pixels); gizmos not yet in the harness |
| spatial post-processes (`DefaultRenderingPipeline` bloom / FXAA / image processing / sharpen / grain / chromatic aberration, a page's own `PostProcess`) | **3D**, the chain per eye (harness `bjs-fx`) |
| the geometry buffer (`enableGeometryBufferRenderer`: GI with `GIRSMManager`, IBL shadows, SSAO2 / SSR forced onto it) | **3D, EXPERIMENTAL**: the G-buffer is drawn again for the second eye (`bjs-gbuf`; below). IBL shadows' temporal accumulation stays one history for both eyes |
| depth of field, SSAO on a depth renderer, SSAO2 / SSR / motion blur on the prepass renderer (drawn once per frame with the page camera) | **2D**, HUD reason (`bjs-flat-dof`) |
| a temporal post-process (TAA, motion blur, SSR: one history for both eyes) | **2D**, HUD reason |
| render on demand (the page's loop stops) | **3D**, idle frames re-rendered |
| WebGPU engine | **3D** since v0.7.0 (`bjs-gpu`); WebGPU snapshot rendering stays **2D** |
| an orthographic camera | **2D**, HUD reason (`bjs-flat-ortho`) |
| several active cameras (`scene.activeCameras`: split screen, a UI or minimap camera) | **2D**, HUD reason (`bjs-flat-two`) |
| a camera that draws into part of the canvas (a configurator under its UI: Nike By You, viewport `(0, 0.39, 1, 0.61)`) | **3D**: each eye draws into the same sub-rectangle of its half, at the page's framing (`bjs-vp`; below) |
| a camera that renders into a texture, or one with its own rig (stereoscopic / VR cameras) | **2D**, HUD reason |
| two scenes rendering to one canvas (an overlay scene with `autoClear` off) | **2D**, HUD reason |
| `scene.customRenderFunction` | **2D**, HUD reason |
| the page switches `scene.activeCamera` while converted | **3D**: the eyes move to the new camera at once (from the setter), or back to 2D when it does not qualify |
| the page asks for WebXR (`createDefaultXRExperienceAsync` and an `immersive-*` session) | stands down (the core's `requestSession` wrapper) |
| an engine on an OffscreenCanvas / in a worker, `NullEngine`, Babylon Native | not converted |

**A camera that draws into part of the canvas.** A configurator often keeps its 3D in the top of a
canvas and its UI over the rest: Nike By You sets `camera.viewport = (0, 0.39, 1, 0.61)` once its
builder opens (panel, 2026-11-06: it went live, then back to 2D on the v0.7.0 draft's "part of the
canvas" rule). Each eye now draws into the same sub-rectangle of its half (eye i: `x = i/2 + x/2`,
`width = w/2`, the same `y` / `height`). The rig declares the WHOLE canvas's vertical FOV,
`2·atan(tan(fov/2) / h)`, so the runtime's eye projections cover the canvas, and each is scaled to the
sub-rectangle (x row × 1/w, y row × 1/h). The page's own framing on its viewport, the camera's axis
through its centre, and the same physical disparity as on the whole canvas. Harness case `bjs-vp`: a
marker above the axis lands at the page's own projection (91.5 px vs 91.6), nothing is drawn below the
viewport.

**The geometry buffer, per eye (EXPERIMENTAL, `T.bjsGBuffer`).** `enableGeometryBufferRenderer()` is
gathered once per frame (`Scene._gatherRenderTargetsStage`) and drawn in the first eye's pass only (the
scene resets its render-target list after each camera), so the second eye sampled the first eye's
G-buffer. The adapter queues it again from `onBeforeCameraRender` of the second eye, before that pass
draws its render targets. What samples it in the eye's own pass then sees that eye's view:
- `GIRSMManager`: its GI pass runs in `onBeforeDrawPhase`, per camera.
- IBL shadows and SSAO2 / SSR forced onto the G-buffer: post-processes, cascaded to the eye cameras.

Two engine facts needed handling:
- **Viewport-mapped passes.** With a post-process chain, the eye renders the scene into the chain's FULL
  texture, as the page camera does. But some passes map their textures through
  `scene.activeCamera.viewport`: SSAO2's combine samples `uv = viewport.xy + vUV · viewport.zw`, and
  GIRSM resets the viewport from it mid-pass. So for the rest of its pass the eye camera reports the
  PAGE camera's viewport. The chain's last pass still draws into the eye's half: `_finalizeFrame` is
  wrapped per scene to put the engine's viewport back first. Without this the first try drew each
  eye's SSAO picture stretched over half its width.
- **History (IBL shadows).** Its accumulation output is drawn after every G-buffer draw (so per eye).
  Its history is copied once per frame, at frame start: `oldAccumulationRT` (the last output) and
  `oldLocalPositionRT` (the last G-buffer positions). The G-buffer's velocity always refers to the
  view drawn before, i.e. the other eye:
  - the left eye's history and velocity both refer to the right eye of the previous frame: consistent;
  - the right eye's velocity referred to the left eye, but its history was still its own.

  Both copies are now made again before the right eye's pass (`T.bjsIblHistory`), so each eye
  reprojects the other eye's accumulated shadows through the velocity, as a TAA follows a moving
  camera.

Harness cases:
- `bjs-gbuf`: SSAO2 on the geometry buffer, the pair matches at the fake's shift with residual 0.44.
- `bjs-gbuf-shared` (A/B, `bjsGBuffer: 'shared'`): the second draw left out, residual 1.60.

Live, headless with the fake session, both playground samples convert: `#VW8IG3#156` (GIRSM, the
right lighting per eye against its 2D frame) and `#8R5SSE#587` (IBL shadows).

**Eye targets: each eye renders like a mono frame (`T.bjsEyeTarget`).** An eye drawn straight into
half the canvas breaks every screen-space lookup keyed to the render target, `uv = gl_FragCoord.xy /
getRenderWidth()`. The IBL shadows material plugin read the left / right HALF of the eye's own shadow
image (panel, 2026-11-06: the ground shadow under playground `#8R5SSE#587` differed between the eyes,
"a glitch"). GIRSM's plugin without a chain, depth peeling and a transmission pass work the same way.

So each eye renders into its own target, the size of its viewport, and a pass copies it into its half:
- the slot is Babylon's own rig post-process, `_rigPostProcess`, cascaded after the page's chain
  (`_cascadePostProcessesToRigCams`; `isIntermediate` is cleared: the cascade marks a lone pass
  intermediate, as for a VR rig);
- the copy is NEAREST and 1:1, MSAA as the canvas has it;
- in its own target the eye's `gl_FragCoord` and `getRenderWidth()` are the eye's.

It is built from the page's own `PostProcess` class (the `BABYLON` namespace, or any post-process
instance in the scene) and our own copy shaders, `dxrEyePass`: GLSL for WebGL, WGSL for WebGPU. They
are registered through the engine's public `Effect.RegisterShader` (7.x / 8.x / 9.x), reached from any
compiled effect. The engine's `pass` shader is registered lazily, so it cannot be relied on. The pass
is attached once ready.

Not available: no `PostProcess` class reachable (a tree-shaken ESM bundle with no post-process at
all). The eyes then draw straight into their halves, as before. `state()` reports `eyeTargets`.

Harness cases:
- `bjs-ss`: a backdrop coloured by `gl_FragCoord.x / renderTargetSize.x` shows the same ramp in both
  halves (2 → 253).
- `bjs-ss-direct` (A/B, eye targets off): the halves read 1 → 127 and 128 → 254.
- `bjs-gpu-ss` / `bjs-gpu-ss-direct`: the same on a WebGPU engine (a WGSL backdrop, the WGSL pass):
  2 → 253 in both halves, against 1 → 127 / 128 → 254.
- `bjs-fx`, `bjs-global`: still pixel-exact at the fake's shift (residual 0.00) through the pass.
- Live, headless: playground `?webgpu#8R5SSE#587` (IBL shadows on WebGPU) showed the other eye's
  ghost without the WGSL pass, and matching shadows with it.

**What the Babylon.js adapter cannot see.**
- An ESM page that builds its engine on a WebGL context it created itself in an earlier task
  (`new Engine(gl)`), with no `window.BABYLON`: the trap is gone by then and there is no global.
- An engine created before `document_start` (never, for a content script).
- Not yet verified on the panel. The harness drives Babylon 9.32.0 only; 7.x / 8.x share the code
  paths used here (`_gl` assignment, `RIG_MODE_CUSTOM`, `_processSubCameras`), not run.

## Try it on the display (Windows box)

**A — in your own DisplayXR Browser (recommended).** `chrome://extensions` → *Developer mode* →
*Load unpacked* → select this folder. Then open or reload a three.js / PlayCanvas page. The
extension loads the committed `dist/auto3d-dev.js`; after editing a source file run
`node build.mjs` here, then reload the extension.

A browser that ships its own auto-3D injects that copy first, and the first injector wins
(`Symbol.for('dxr.auto3d')`). The extension then does nothing on the page. You can tell from the
console: `auto3d-core.js … core armed (v<the browser's>)` is the browser's copy, and
`auto3d-dev.js … core armed (v<manifest.json>)` is this one. To test this copy, start the browser
with `--disable-auto-3d`, or use B.

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
| a supersplat-viewer page, `…/scene/<id>?webgl` (the query starts with `?`, not `&webgl`) | PlayCanvas: an ESM app found through the canvas-id trap (route 2), `autoRender = false`. Without `webgl` the viewer picks WebGPU (2D before v0.6.0; since then the WebGPU path, not yet seen on the panel). Note that on `superspl.at/scene/<id>` the viewer runs in an iframe whose own URL decides the device, so `?webgl` on the scene page may not reach it. A standalone copy of the viewer (its built `index.html` served locally) needs the scene's `settings.json` next to it (`./settings.json`); without it the viewer never starts |
| the PlayCanvas engine examples, `loaders/glb` | PlayCanvas: the camera alternates perspective / orthographic every 2 s (3D, then 2D; see below) |
| `https://playground.babylonjs.com/` (any playground; the render canvas is the right-hand pane) | Babylon.js: the UMD build, found by the constructor trap; the default template's `camera.setTarget(Vector3.Zero())` is the convergence target |
| `https://www.babylonjs.com/` | Babylon.js: the hero scene |
| a Babylon.js page built with Vite / webpack (ESM, no `window.BABYLON`) | Babylon.js: the constructor trap is the only route |

### Hardware verification checklist (for the tester)

1. **It converts.** The console shows `[dxr-auto3d] three.js r… renderer found`, `PlayCanvas app found via …` or `Babylon.js engine found via …`, then `live on canvas…`.
   The go-live line carries the convergence of the first frame, often a fallback (`5.00 units
   (estimator)`) before the page's splats or model have loaded. Since v0.5.4 one follow-up line,
   `convergence settled: 2.95 units (estimator)`, follows once the source or the value has moved
   (> 5 %) and the eased value is at rest; at most one such line per 2 s and three per document. The
   source (`fixed: open scene`, `target: camera.lookAt`, `estimator`, `manual`) is also on the HUD and
   in the chip's `auto` tooltip.
   The HUD (bottom left) reads `DXR auto-3D ● camera rig · depth 0.50 · conv … · 3D <growing> · flat <small>`.
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
   `standing down (the page requested 'inline-3d')`, and **detection stops there** (since v0.5.4):
   no `PlayCanvas app found` / `renderer found` line may follow the `standing down for this
   document` line (the sentinel's traps, polls and `load` look are off, and the adapters' `consider` /
   `observe` / `register` are no-ops once the core has stood down for good). Press `Ctrl+Alt+3` on a converted page: back
   to 2D at once, the page intact. Press it again, without touching the page: 3D again within a
   second or so, including on render-on-demand pages (`webgl_geometry_teapot`, supersplat-viewer).
6. **Frame rate.** Every converted draw runs twice. Note the page's fps before and after.

## Controls

### The 3D chip

The product control, in both product and dev mode. A small pill (at most 64×28 CSS px; 44 tall on
a coarse pointer) in the **top-right** corner of the converted canvas, inset 8 px; if page UI covers
that corner it tries bottom-right, top-left, bottom-left, and shows **no chip** when all four are
taken (a corner counts only when `elementsFromPoint` at its box's corners + centre first hits the
canvas or its cover). States: **offer** (outlined; a click converts and saves `allow`), **live**
(green dot; amber after 1 s continuously without two-view frames, while the depth fade runs, or
while the frame-rate guard waits to retry; expanded for 3 s when it first appears), **off**
(outlined; expanded for 5 s after a turn-off), **no display** (v0.5.2: outlined, hollow dot, tooltip
*3D display not available to this window*; a click opens the menu). The dot is **debounced**: eye
tracking flips `isTracking` 0/1 every few seconds in normal use, so it turns amber only after
`eyesOffMs` (1 s) without two-view frames and back to green after `eyesOnMs` (300 ms) with them.
**No display** is shown when the session is live but no two-view frame has arrived in the
`coverMaxMs` (5 s) since the layer (a second browser instance, whose session got
`XR_ERROR_LIMIT_REACHED`, stays mono), or when the layer's display API answered "no display"
(`displayOk === false`, back to 2D at once); the core then reports
`{ status: 'flat', reason: 'no-display' }`. The `noViewsMs` stand-down is unchanged. A click on the pill toggles the
site (`block` / `allow` saved); the caret opens a menu: site toggle, depth slider (live, saved on
release), Style (camera / display rig), Focus (nearer / auto / farther), Reset, and **Just this
time** (on or off now, nothing saved). Menu keys: arrows, Home / End, Escape (closes and returns
focus to the pill). It hides while a page modal (`<dialog>`) covers the canvas, and shows nothing
after a guard trip or an opt-out. **In fullscreen** (v0.5.1): a fullscreen element enters the top layer
after the chip and would paint over it, so when the fullscreen element is (or contains) the converted
canvas the chip host is torn down and a **fresh** one is built and shown once (the newest top-layer
entry paints on top); on leaving fullscreen, the same again. The pill hides after 3 s without pointer
movement and comes back on the next move. Measured headless: Chromium **paints** the fresh chip over
the fullscreen canvas but routes pointer input there to the fullscreen element, not to a later
non-modal popover, so in fullscreen the chip shows the state but does not take clicks (panel check).

It must stay out of the weave: a **plain quad** (no opacity, filter, transform, blend, mask or
clip-path anywhere; fades are colour alpha only), always smaller than the tile, hidden with
`display:none` inside its shadow root, its popover shown **once** and never toggled (a second
`showPopover()` would lift it above a page modal opened since). Its live moment keys off the cover
drop or `layerAt + holdMs`, whichever comes first (risk R6). Whether it composites crisp over the
woven tile is **not yet judged on the panel** (see [Verified](#verified-and-what-is-not)).

### The frame-rate guard, the GL clamp, reduced motion

- **Guard** (`guard.js`). A page that cannot afford the conversion (two eye draws, the replay, the
  weave) goes back to 2D for the rest of the document instead of stuttering in 3D. Baseline: the
  page's own 2D rate from its last 60 draws before the flip (intervals ≤ 250 ms, ≥ 20 needed, else
  no baseline; a render-on-demand page has none). Sampling starts 1 s after the fade-in settles;
  hitches > 250 ms and hidden time are excluded, and a `visibilitychange` starts over. **Warm-up
  (v0.5.2):** no window starts within `guardWarmupMs` (4 s) of the cover drop, so a page that is
  still loading its assets is not judged by its load (Spark hello-world / streaming-lod tripped at
  25-39 fps 4-5 s after go-live on the panel, then run at a steady 60 / ~44). Trip: under
  `guardFps` (**15** since v0.5.3; 24 in v0.5.2, 40 before; David, 2026-09-28: 24 still reverted heavy splat worlds that read well at 25-44 fps) over `guardMs` (2 s) **and**, when there is a baseline, under **0.6** × baseline (0.8 before; David, 2026-09-28: heavy splat worlds run 25-44 fps in 3D on the panel and look great) (a
  page that already runs at 30 fps in 2D is not the conversion's fault).
  **Retry once (v0.5.2).** On ANY first trip in a document: the ordinary turn-off (fade, out-cover,
  staged stand), then a wait (report `'converting'`, chip amber): at least `guardRetryMs` (6 s), then until the page's own 2D rate has been steady for `guardSteadyMs` (2 s: four 500 ms buckets within 1.3× of each other; a page that draws almost nothing counts as steady), at most `guardRetryMaxMs` (30 s). Panel, Marble / streaming-lod: a fixed 6 s retry landed while the world was still streaming and tripped again at 20.0 fps against a 2D rate of 25.4. Then ONE
  retry whatever the page's 2D rate meanwhile. v0.5.1 retried only when the page was slow in 2D too,
  which blocked the Spark pages (58 fps in 2D: their slow phase was the load, not the conversion).
  The page's 2D draws during the wait are the retry's baseline, so the second trip is judged with
  the 0.6 × baseline rule when there are enough of them. A second trip blocks for the rest of the
  document: report `'guard'`, nothing saved.
- **GL clamp.** The SBS store fits the zero-copy width cap (3072) **and** the context's own limits
  (`MAX_TEXTURE_SIZE`, `MAX_RENDERBUFFER_SIZE`, `MAX_VIEWPORT_DIMS`, read once per canvas): a 2×-wide
  store is over those on many Android GPUs. Each axis is capped on its own (v0.5.2).
- **Reduced motion.** Under `prefers-reduced-motion: reduce` the depth fade is 1 ms, never 0:
  `rampMs` 0 skips the turn-off's out-cover and the raw side-by-side flash comes back (risk R5).
  Followed live (`change` listener).
- **PlayCanvas shadow offset.** The engine fades a light's shadow where view depth passes
  `shadowDistance`, measured from the eye; the display rig puts the eyes metres behind the page
  camera, so a ground inside the page's distance was past it for both eyes (panel,
  `gaussian-splatting/simple`: shadow in 2D, none in 3D). While converted, every shadow-casting
  light gets its own distance + the mean eye pull-back (mean eye-local z of the two views), written
  only on a > 1 cm change; the page's value is kept per light and put back on restore (the staged
  stand included); lights are re-listed every 30 frames. three.js has no distance fade.

### Tuning keys (v0.5.2)

Constants in `core.js` (`TUNING`), not per site; the harness overrides them through `cfg.test` in a
dev build only.

| Key | Default | Meaning |
|---|---|---|
| `guardWarmupMs` | 4000 | no frame-rate-guard window starts within this long after the cover drop |
| `guardFps` | 15 | the guard's absolute floor (and 0.6 × the page's 2D rate when it has one) |
| `guardRetryMs` | 6000 | after a first guard trip, wait at least this long before the one retry ... |
| `guardSteadyMs` | 2000 | ... and until the page's 2D rate has been steady this long ... |
| `guardRetryMaxMs` | 30000 | ... or this long at the latest |
| `eyesOffMs` | 1000 | the chip's dot goes amber only after this long without two-view frames |
| `eyesOnMs` | 300 | ... and back to green after this long with them |
| `eyeScale` | 0.5 | per-eye width / the element's device width (before v0.5.2: of the page's store) |
| `maxEyeDpr` | 3 | the device-pixel ratio the eye is sized at, at most |
| `maxSbsWidth` | 3072 | the SBS store's width cap (browser-pvt#24), then the GL limits |
| `coverMaxMs` | 5000 | the join cover's longest hold; also the "no display" threshold |
| `openSceneMode` | `'fixed'` | open scenes (no target, no bounded subject): `'fixed'` focus at real scale, or `'percentile'` (the 0.5.3 room rule) |
| `openSceneConvM` | 2 | `'fixed'`: the focus distance in front of the page camera, in scene units read as metres |
| `openSceneRealDepth` | 0.5 | `'fixed'`: the camera-rig depth that means the viewer's real IPD (`ipdFactor` 1); less scales it down linearly |
| `convRoomPercentile` | 0.7 | `'percentile'`: the percentile of the in-view apparent-size-weighted depths; `'fixed'`: only the scale-sanity note |

**Eye size (v0.5.2).** `eyeW = round(cssW × min(devicePixelRatio, maxEyeDpr) × eyeScale)`,
`eyeH = round(cssH × min(devicePixelRatio, maxEyeDpr))`, from the canvas's layout box, regardless of
the page's own store (Spark hello-world keeps a 1038-px store on a 1038-px CSS canvas on a 2.5×
panel: its eyes were 519×703, "a little low res"; now 1298×1758, the same as a three.js page at
`setPixelRatio(2.5)`). The SBS store is the element's full device size: two eyes side by side at
half width each. Each axis is then capped on its own, the width to `maxSbsWidth` / 2 per eye and
the GL limits, the height to the GL limits: the eye's aspect is not kept (it is squeezed
horizontally by design, the weave un-squeezes), so a width cap never costs height (a joint scale
cost ~40 % of the pixels on the panel). The page keeps reading its own mono store, and `restore()` puts it back. A canvas
with no CSS size (laid out at its store size) gets its current used width / height pinned inline
while converted (the same box), and unpinned after.

### Coexistence with Convert to 3D (v0.5.6)

The DisplayXR Browser's **Convert to 3D** (lift) converts an image, video or canvas from an isolated
world. On a canvas auto-3D has converted the drawing buffer is side by side with an `XRDisplayLayer`
bound: lifted, those pixels would be taken for a flat picture and a second inline-3D session would
open on the element. So each feature refuses the other's element. The isolated world shares the
DOM, so **DOM attributes are the contract**, both tested by presence:

- **Out: `data-dxr-auto3d="live"`** on the canvas element auto-3D converts, set when the canvas is
  claimed (before its store first becomes side by side, so it covers `converting` and the go-live
  cover) and removed once the store is mono again and the layer is released, on **every** exit path:
  the user (chip, `Ctrl+Alt+3`, the host's decision), the frame-rate guard (including the wait before
  its retry), a stand-down because the page asked for `inline-3d` / WebXR, the opt-out meta, no
  display / no eyes, the session ending, `pagehide`. One pair of helpers in `core.js`
  (`claim` / `unclaim`) owns both the marker and `owner`, so the two cannot drift. It is output only:
  nothing in the shim reads it, and no selector of ours matches it (ours are the exact names
  `[data-dxr-auto3d-cover]` / `-chip` / `-hud`). The sentinel's `MutationObserver` watches
  `childList` only, so the write does not reach it.
- **In: `LIFT_MARKERS = ['dxr-lift']`** (one constant in `core.js`), tested by presence (any value,
  `off` included) on the canvas or an ancestor (across shadow roots). A canvas carrying it is never
  converted: not at first, not from the chip of an `offer` page (it is not offered), not on the
  guard's retry. One console line (`not converting canvas…: element is lifted (Convert to 3D,
  [dxr-lift])`), report `{ status: 'standdown', reason: 'lifted' }`, the page untouched. A canvas
  that gets it **while live** (checked every 30 session frames, ~2/s, next to the opt-out check: no
  observer, no timer) goes back to 2D the normal way (fade, out-cover, staged release). Either way it
  **stays refused for the rest of the document, until the user turns auto-3D on again** (chip,
  `Ctrl+Alt+3`), which looks again.

  What lift puts on the DOM today: a `<video>` on the native path carries `dxr-lift` (`auto` while
  live, `off` while explore owns the pixels) plus `dxr-lift-strength` / `-convergence` / `-priority`,
  removed on the second Convert to 3D and on Exit / disposal (browser patches 0328, 0331, 0335,
  0337). A lifted `<img>` or `<canvas>` **source carries no attribute**: the only trace is a sibling
  host `div[data-inline3d-lift]`, removed on Exit, which we do not key on (a sibling, not an
  ancestor, and due to be replaced by a marker on the source when canvas lift returns). Convert to 3D
  is **not offered on canvases** in browser v1.2.0 / v1.2.1, so this check is forward-looking: today
  it fires only when a page author puts `dxr-lift` on a canvas or a container, where staying 2D is
  right.

### Opting out, and the dev switches

- **A page** opts out with `<meta name="displayxr-auto3d" content="off">` (see
  [Architecture](#architecture-a-sentinel-one-core-one-adapter-per-engine)): the core never loads;
  inserted later, a live canvas goes back to 2D within 30 session frames.
- **Dev mode** (the unpacked extension) is on unless the page's `localStorage.dxrAuto3DDev === '0'`;
  with it off the dev bundle behaves as the product (no HUD, no hotkeys, no `window.__dxrAuto3D`, no
  `__dxrAuto3DTestCfg`, and a `block` never loads the core).
- **`launch.cmd`** passes `--disable-auto-3d`, which keeps the browser's own auto-3D injector off the
  page so the dev extension is the only one (the first injector would win anyway, through the
  `Symbol.for('dxr.auto3d')` marker).

### Dev hotkeys

`Ctrl+Alt+…`: **3** turns it on or off for this site · **P** camera rig / display rig · **=** /
**-** depth of the active rig (×1.25 / ÷1.25, 0.02 to 1) · **0** / **9** convergence farther /
nearer · **8** reset the active rig's depth and the convergence · **D** HUD. Everything is
remembered per origin, and **depth per rig**: camera 0.50, display 1.00 by default, and toggling
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
  In an **open scene** (fixed focus, see Convergence): `metersToVirtual = 1` (real scale),
  `convergenceDiopters = 1/2`, `ipd/parallax = clamp(depth / 0.5, 0, 1)`: comfort 0.25 at depth 0.5.
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
  **Rule (v0.5.5): the virtual display's centre is the object view's pivot, and on entering the
  display rig it is the centre of the screen on the convergence plane (page camera + forward ×
  convergence distance).** Mechanism (`core.pivotOffset` / `core.eyePose`, both adapters): the eyes
  hang from a render camera whose rotations — the page camera's, whatever the page's controls pivot
  about — are re-applied about the display's centre; `T.displayPivot: false` is the 0.5.4 rigid
  attach (harness A/B only).

Defaults (`DEFAULT_DEPTH`, one line at the top of `core.js`, David's call: 0.30 on 2026-09-27, raised to 0.50 on 2026-09-28 after a panel pass where 0.3 read shallow): **camera rig
0.50**, **display rig 1.00**. Display depth 1 is the physically true portal: natural IPD and full
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
`--load-extension`, so the pre-split `content.js` can be swapped in for the parity run. `run.mjs`
builds `dist/` **in memory** from the sources (`build.mjs`'s `build()`), so it always tests the
working tree, never a stale committed `dist/`. Cases are a registry: every `test/cases/*.mjs`
default-exports `(env) => case[]`, loaded in file-name order; a case may carry its own
`run(page, helpers)` / `check(r, t, helpers)`. Dev-mode cases inject `dist/auto3d-dev.js` and read
`window.__dxrAuto3D`; product-mode cases (`productShim(hostCfg)`) inject `test/fake-host.js`, which
evaluates `dist/auto3d-sentinel.js` + `dist/auto3d-core.js` with an indirect `eval` as the browser
would and records `loadCore` calls, `cap.save` and `cap.report` on `window.__dxrFakeHost`.

```bash
cd tools/auto3d-shim/test
npm install                      # puppeteer-core only
node deps.mjs                    # three@0.180.0 + playcanvas@2.22.3 + playcanvas@2.23.0 + @sparkjsdev/spark@2.2.0 + @playcanvas/supersplat-viewer@1.37.0 + babylonjs@9.32.0 + babylonjs-gui@9.32.0 into .deps/ (npm pack; local overrides below)
node run.mjs                     # every case; `node run.mjs a a-legacy` for one; KEEP=1 writes out/<case>.png
```

**Engines, and a box with no registry access.** `deps.mjs` fails loudly (non-zero exit, the file
and the override to use) instead of leaving a page that never converts, and `run.mjs` checks the
same files and the Chrome binary before it starts (exit 2), and fails a case at once, naming
the file, if a page gets a 404 for anything under `/deps/`. Every file can come from a local copy:
`THREE_BUILD_DIR` (`three.module.js` + `three.core.js`), `PLAYCANVAS_MJS`, and for the addons
`THREE_ORBIT_CONTROLS` / `PLAYCANVAS_CAMERA_CONTROLS`, or found next to the first two when they point
into an npm package layout (`<THREE_BUILD_DIR>/../examples/jsm/controls/OrbitControls.js`,
`<PLAYCANVAS_MJS>/../../scripts/esm/camera-controls.mjs`). The Spark page also needs
`SPARK_DIST` (a dir holding `spark.module.js`; default `npm pack @sparkjsdev/spark@2.2.0`) and
three's `postprocessing/Pass.js` (`THREE_PASS_JS`, or next to `THREE_BUILD_DIR` in an npm layout).
The CameraFrame pages need playcanvas 2.23.0 (`PLAYCANVAS_CF_MJS`, its `build/playcanvas.mjs`) and the
real-viewer cases supersplat-viewer 1.37.0's `public/` (`SUPERSPLAT_VIEWER_DIR`, holding `index.html`,
`index.js`, `index.css`). The Babylon.js pages need babylonjs 9.32.0's UMD `babylon.js` (`BABYLON_JS`) and babylonjs-gui
9.32.0's `babylon.gui.js` (`BABYLON_GUI_JS`).
With all of them set, nothing is fetched. (On the Windows box `npm` may not
be on the shell `deps.mjs` spawns: point the overrides at `npm pack`ed copies.)

A converting case settles only once the go-live depth fade has finished (`rampK` exactly 1, no ramp
running), so the rig is always sampled at the configured depth.

| case | page | asserts |
|---|---|---|
| `a` | `pages/three-keyframes.html`: keyframe turntable, shadowed floor, flat HUD pass; freezes after 60 frames (replay from then on) | SBS = 2 × eye, the page still sees its mono `canvas.width`, halves differ, 64 px shift, stereo > 0, no flat scene frame after the eyes arrive, rig fields, convergence 8 ± 5 % |
| `spark` | `pages/three-spark.html`: Spark 2.2.0, a procedural `SplatMesh` (~3k splats), `setAnimationLoop`, `lookAt` the lattice 5 units ahead | as `a`, plus: ONE Spark update per stereo frame, no regenerate / re-sort once settled, the last sort made for the camera of the last update, Spark's `renderSize` = the eye (fails without v0.5.4: the page's mono store) |
| `spark-eyes` | the same page, the fake's eyes 0.04 apart (`eyeX` 0.02) | skew shift minus the eyes' parallax (≈ 56 px), stable frame, the same Spark assertions (fail without the one-frame-per-pair change) |
| `spark-idle` | `three-spark.html?freeze=30`: stops drawing once sorted | as `spark`, with every frame a replay |
| `spark-est` | `three-spark.html?at=7`: no `lookAt`, the lattice 7 units ahead | as `a`, convergence 7 ± 5 % from the `estimator` (the SplatMesh's sampled centres; 5.00, the default, before) |
| `spark-room` | `three-spark.html?room=1`: no `lookAt`, the camera inside the mesh (lattice 8 ahead + a sparse 15-unit shell of large splats around the camera): an open scene | as `a`, convergence exactly 2 from `fixed` (via `open scene`), rig at real scale: `metersToVirtual` 1, ipd = parallax = 1 at depth 0.5 |
| `spark-room-percentile` | the same page, cfg `openSceneMode: 'percentile'` | convergence 8.6 ± 5 % from the `estimator` (the 0.5.3 room rule, 70th percentile: the back of the lattice; the weighted median gave 8.06, the r²-weighted centroid 10.4) |
| `spark-room-percentile-p50` | the same, plus cfg `convRoomPercentile: 0.5` | convergence 8 ± 5 % (the weighted median: the key is live) |
| `spark-room-subject` | `three-spark.html?room=1`, a 0.4-unit box added 3 units ahead 1 s after settling | `fixed` (2, m2v 1) before; `estimator` after, converging on the box (3 ± 5 %), m2v = d again; ONE `convergence settled: ~3 units (estimator)` console line |
| `e-postfx-view0` | `three-postfx.html?view=identity`: the chain, its camera kept at `setViewOffset(w, h, 0, 0, w, h)` (the sandworm page at rest), an unlit magenta marker at (0, 1.5, 3) | as `a`, plus the marker's height in the left eye = the page's own projection of it (`window.__expectNdcY`, ± 0.02 NDC). The fake skews x only, so without the view both halves are equally wrong and only this check sees it. Fails before v0.6.3: never converts, with the sandworm page's 2D line |
| `e-postfx-shift` | `?view=shift`: a kept lens shift, 12 % of the height down | as `e-postfx-view0` (marker at 0.515; 0.275 without the view) |
| `e-postfx-crop` | `?view=crop`: a kept 2× crop, off centre | as `e-postfx-view0` (marker at −0.051; 0.275 without the view), the pair shift doubled: 128 px (`pairShift` 0.2) |
| `e-direct-shift` | `?view=shift&chain=0`: the scene straight to the screen | as `e-postfx-shift`. Before v0.6.3 it converted but drew flat, and the cover never dropped |
| `e-postfx-jitter` | `?view=jitter`: a sub-pixel `setViewOffset` around the scene pass only, cleared after it (SSAA / TAA) | no session requested, `flat` with the jitter reason in `state()` and on the HUD, the `stays 2D` console line |
| `e-postfx-taa` | `?view=taa`: a sub-pixel Halton jitter set every frame and never cleared (a page's own TAA) | no session requested, `flat` with the jitter reason in `state()` and on the HUD. Fails on v0.6.3: converts |
| `e-postfx-taa-late` | `?view=taa-late`: the identity view for 30 frames, then the same jitter, left on | converts (one session, one layer), then `back to 2D: the scene pass jitters …`, ends not live with the reason. Fails on v0.6.3: stays live |
| `e-postfx-taa-short` | `?view=taa-short`: sample 1 held for 20 frames (a TAA while the camera moves), then samples 2–6 left set, then the scene pass stops (settled) | `back to 2D: the scene pass jitters …`, ends not live with the reason. Fails on the first v0.6.4 cut: stays live |
| `e-postfx-taa-half` | `?view=taa&rtScale=0.5`: the same jitter on a half-size scene target, in that target's px (±1 canvas px) | no session requested, `flat` with the jitter reason. Fails on the first v0.6.4 cut: converts |
| `e-postfx-bob` | `?view=bob`: the 12 % lens shift bobs 0.5 px on y, period 8 frames | converts and stays live, the marker at the page's own projection, no jitter line. Fails on v0.6.4: stays 2D |
| `e-postfx-spring` | `?view=spring`: an underdamped spring's tail on x (0.9 px decaying, period 7 frames) | as `e-postfx-bob`. Fails on v0.6.4: stays 2D |
| `e-postfx-parallax` | `?view=parallax`: a lerped mouse parallax on x (the mouse wobbles by whole px, the offset follows at 0.2 a frame) | as `e-postfx-bob`. Fails on v0.6.4: stays 2D |
| `e-postfx-pan` | `?view=pan`: the lens shift drifts 0.3 px a frame, one way, set every frame | converts, the marker at the page's own projection: a slow pan is framing, not jitter |
| `e-postfx-miss` | `?rtScale=0.25`: the scene into a quarter-size target | 2D, and the 2D line names the near miss: `target 320x180 is under half the canvas's 1280x720 px` |
| `e-postfx-eyes` | `three-postfx.html`, the fake's eyes 0.2 apart (`eyeX` 0.1): real parallax | the pair shift is 39 px: the skew's 64 minus the eyes' parallax at the subject (≈ 25). Swapped eyes would give 64 + 25. Until this case, the chain path's eye order was checked with the skew only (depth-independent) |
| `e-postfx-mirror` | `?mirror=1`: the composite samples `vec2(1.0 - vUv.x, vUv.y)`, and a pillar stands off centre | as `a` (64 px, the right way round); `chainMirror` true; the console line `the post chain … mirrors its picture left-right` |
| `e-postfx-mirror-overlay` | `?mirror=1&overlay=1`: after the scene, two overlay scenes (one child each, nothing in view) seeded into targets of their own: three seeds a frame, the last blank, as sandworm's on the panel | as `e-postfx-mirror`, decided on the first ask, convergence 8 from the estimator on the main seed. Fails when the last seed is used instead: never decided (the 3 s fallback, not mirrored), and convergence 5.00 (the default: the overlay's bounds) |
| `e-postfx-mirror-ctl` | the same page, cfg `chainMirror: false` | the pair shift is −64 px: pseudoscopic, the panel's report reproduced |
| `e-postfx-mirror-eyes` | `?mirror=1`, eyes 0.2 apart | 39 px, as `e-postfx-eyes`: eye order and parallax direction kept through the mirror |
| `a-legacy` | the same page with the **pre-split** `content.js` (commit `84b14f7`) | the same, plus **parity with `a`**: byte-identical frame (MAE 0.000), identical rig and convergence |
| `a-off` | the same page, site switched off | no session requested, nothing converted |
| `b` | `pages/pc-mesh.html`: ESM PlayCanvas, **no globals**, `RESOLUTION_AUTO`, render-on-demand after 60 frames | found through the constructor trap, SBS, 64 px shift, counters, rig, convergence 8 ± 5 % |
| `a-kill` / `b-kill` | three.js keyframes / PlayCanvas meshes, both frozen (render on demand): `Ctrl+Alt+3` while live, then again | back to 2D (PlayCanvas: `xrViews` released), the canvas shows one mono view; **no raw pair after `close()`** in the commit model (below); the **out-cover holds a real picture** (textured, and matching the mono canvas the right way up); on again, **3D again within 4 s** with the page not drawing |
| `a-target` | `pages/three-orbit.html`: real `OrbitControls`, target 5 units away, scene centre 8 | convergence 5 ± 5 %, source `target` on the HUD and in `state()` |
| `b-target` | `pages/pc-orbit.html`: the engine's `CameraControls`, `focusPoint` 5 units away | the same |
| `a-display` | three.js keyframes: `-` on the camera rig, `P`, `-`, `=` `=`, `-`, `P`, `P`, then a reload | camera depth 0.5 → 0.4 (m2v 0.4·d/0.5); the display rig declared (portal at −d, height 2·d·tan(fov/2)) at **its** 1.0 with `ipdFactor = parallaxFactor = 1`; `-` there gives **both** 0.8 and leaves the camera rig at 0.4; `=` twice caps at 1.0; each toggle restores that rig's own depth; HUD + `state().depth` show the active rig's; `localStorage` and a reload give camera 0.4 / display 0.8 |
| `a-migrate` | three.js keyframes with a v0.3 `{depth: 0.35}` pre-seeded in `localStorage` | camera 0.35, display 1.0 |
| `b-late` | `pc-mesh.html?stallMs=2500`: the page draws nothing for 2.5 s once the layer exists; the fake has no eyes until 3.2 s and no display API; `noViewsMs` 1.5 s | converts with ONE layer and no false no-eyes stand-down (the timer starts at the first draw, ~2.5 s in) |
| `b-noviews` | `pc-mesh.html`, no eyes ever, no display API, `noViewsMs` 1.5 s | back to 2D (layer closed) 1.5-2.5 s after the FIRST DRAW, with the reason in the console: the timer still fires |
| `b-flip` | `pages/pc-flip.html`: one camera alternating perspective / orthographic every 2 s | 2D in each ortho phase, 3D in each perspective phase, a fresh session + layer each time with the full cover (the behaviour documented above), no raw pair at any close |
| `c` | `pages/pc-gsplat.html`: `ports_25.sog` (from the gallery repo's `public/bench/`; `SOG_DIR` to override), `window.app` | as `b`, plus the footprint shader patched; convergence = 2.5 bounding radii ± 5 % |
| `d` | the SDK's `samples/splat/?engine=playcanvas&url=/bench/ports_25.sog` | the shim stands down: `foreign` set, no session of its own, nothing converted, the HUD says so, no `app found` line after the stand-down |
| `d-pc` | `pc-mesh.html?xrFirst=1`: the page asks for `inline-3d` before its app exists | as `d`; fails without v0.5.4 (the app's constructor loaded the core, which stood down, and the same find then took the app on: `PlayCanvas app found` after `standing down`) |
| `p-smoke` | three.js keyframes in **product mode** (fake host, `decision: 'allow'`), with a hostile `__dxrAuto3DTestCfg` | goes live; `loadCore` once; reports are transitions only (converting before live); nothing saved; no `__dxrAuto3D` / HUD; the test config is ignored; the only window symbol is the value-only marker |
| `p-block` | product mode, `decision: 'block'` | the core is never loaded, no session |
| `p-double` / `p-double-dev` | the product injector and the dev bundle both injected, in either order | the first injector wins: one core, one session, one layer |
| `s-cost` | `pages/plain-2000.html`: 2,000 elements, no engine, product mode | `loadCore` never called; only `HTMLCanvasElement.prototype.getContext` changed; `'pc' in window` false; no timers; only new window key `__THREE_DEVTOOLS__`; sentinel eval < 0.5 ms (median of 5); `div.id` reads within ±5 % of a control |
| `s-late-canvas` | `pages/plain-late-canvas.html`: a canvas added after load (id read, never a context) and a `2d` canvas, product mode | `loadCore` never called; no sentinel timer pending or ever created (fails without v0.5.4: the observer's arm scheduled the 10 s expiry sweep, the corpus's google.com finding) |
| `s-meta` / `s-meta-boot` / `s-meta-late` | `pages/meta-off.html`: the meta static, inserted before the first draw, inserted 2.5 s in while live | core never loaded / never activates / turned off within 30 session frames; report `optout`; one console line |
| `s-block-pc` | PlayCanvas, product `block` | detect-only: one `{ off, PlayCanvas }` report, no session, the id trap removed |
| `s-cost` (v0.5.1 addition) | the same | the parse-time canvas observer's callbacks < 0.5 ms per load (median of 5) while the 2,000 elements go in |
| `s-pc-dyn` | `pages/pc-dyn.html`: a script-created canvas, inserted and handed to `new Application` in the **same task**, no globals | still **2D**: the observer's callback is a microtask, so the id is read before the trap exists (and before the context); the page keeps working, one console line says why, the trap expires |
| `s-pc-dyn-defer` | `pc-dyn.html?defer=1`: the launcher pattern, inserted then `new Application` in a later task | **3D**, found through the id trap the observer armed; no sentinel timer 1 s after go-live |
| `s-three-settle` | three.js keyframes, product | once live, no PlayCanvas search timer (poll / sweep) pending 1 s after go-live, none created in the next 3 s, id trap off |
| `s-three-extra-gl` | three.js keyframes + a second WebGL canvas | the search goes on after go-live (another canvas has WebGL); the page then asks for `immersive-vr` → stand-down for good → `S.disarm()`: no timer, the extra canvas's id trap off |
| `s-dev-plain` | the dev bundle on the plain page | the core is not loaded (no `__dxrAuto3D`, no HUD) |
| `g-trip` | PlayCanvas orbit, `frameCostMs` 90 in the fake session rAF (3D ~10 fps), no 2D baseline | the guard trips, waits `guardRetryMs` (report `converting`), retries ONCE with the wait's 2D rate as baseline, trips again → blocks; two sessions, still two 5 s later, report `guard`, no raw pair at either close (commit model), the out-cover holds a picture |
| `g-retry` | PlayCanvas orbit, the page's own rAF burns 90 ms from the start (no baseline) | first trip → ONE retry, whose baseline is the ~10 fps drawn during the wait → **live**, two sessions, no `guard` report |
| `g-loading` | PlayCanvas orbit, the page burns 90 ms a frame (~10 fps) for 5 s after go-live, then runs clean | ends **live**, no `guard` report (the warm-up) |
| `g-loading-long` | the same, 8 s of burn | first trip during the load, 2D fast meanwhile, ONE retry anyway → **live** (v0.5.1 blocked here) |
| `g-steady` | the page alternates 120 / 60 ms burns every 700 ms for 15 s after go-live (still streaming) | the retry waits past `guardRetryMs` until the 2D rate is steady (after 16.2 s), names it, and ends **live** |
| `g-30fps` | the page's own rAF burns 90 ms a frame (~10 fps in 2D and 3D; below `guardFps` 15, never below 0.6 × baseline) | the guard does **not** trip |
| `g-clamp-three` / `g-clamp-pc` | `glLimit` 512 | eye ≤ 512 with the aspect kept, the skew shift still ≈ 0.1 × eye width |
| `a-dpr2` | `three-keyframes.html?pr=1&w=600&h=400` on a DPR 2 viewport (`deviceScaleFactor` 2) | eye 600×800 (half the device width, the full device height), SBS 1200×800, skew shift 60 px; the page reads 600×400 at pixel ratio 1; its store is 600×400 again after the turn-off |
| `g-reduced` | `prefers-reduced-motion: reduce` | `rampMs` 1, and the turn-off still takes the out-cover |
| `pivot-three-orbit` / `pivot-pc-orbit` | `three-orbit.html` (OrbitControls, target 5 ahead) / `pc-orbit.html` (CameraControls), camera rig → display rig (`ctl.setRig`) | the display's centre (page camera × (pivot offset + rig position)) = the camera rig's convergence point (screen centre on the convergence plane) within 1 %, `virtualDisplayHeight` = the camera rig's framing there (2·d·tan(vfov/2)) within 1 %; three: after a 25° orbit about the controls' target the centre is still on the target; back on the camera rig, no offset |
| `pivot-spark-room` / `pivot-pc-mesh` | `three-spark.html?room=1` (Spark open world, fixed 2 m) / `pc-mesh.html`, the same toggle, then a 25° first-person turn (the camera rotates about itself, 5 × 5°) | as above, plus: the display's centre moves < 1 % of d across the view axis; eye 0 as the adapter composed it sits at centre − forward·d (the render camera orbits the display), not at the page camera; A/B with `displayPivot: false` the same turn swings it by > 30 % of d (0.5.4) |
| `g-shadow` / `g-shadow-ctl` | `pages/pc-shadow.html`, display rig, eyes pulled far back | with the offset the ground patch in each eye tile is shadowed (~20 levels darker) and `shadowDistance` is restored after; with it off (control) the eyes lose the shadow |
| `chip-place` / `chip-fallback` / `chip-none` | three.js keyframes; `pages/three-corner-ui.html` (fixed UI in one or all corners) | top layer, top-right inset 8, ≤ 64×28, no render-surface CSS, hit test hits the host; bottom-right when top-right is taken; none when all four are |
| `chip-click` / `chip-offer` | product host | click → off + `block`, again → on + `allow`, "Just this time" saves nothing; offer → outlined pill, click converts + saves `allow` |
| `chip-input` | three.js keyframes | a drag starting on the pill reaches no page bubble listener and moves nothing |
| `chip-layout` | three.js keyframes | **no layout change**: DOM, attributes, boxes and computed styles identical before / after go-live (host + cover excluded, R7 allowlisted); the only attribute added is the canvas's `data-dxr-auto3d="live"` |
| `chip-dialog` | `pages/three-dialog.html` | a page `<dialog>` modal over the canvas hides the chip; closed, it comes back; the R9 `::backdrop` neutraliser |
| `chip-a11y` | three.js keyframes | roles, menu arrows / Home / End, Escape closes and returns focus, the slider |
| `chip-fs` | three.js, a real `canvas.requestFullscreen()` | a new host (old one gone, one in the document, top layer), **painted** above the fullscreen canvas (pill region differs shown vs hidden), hidden after 3 s idle, back on a move; a fresh host again on exit |
| `chip-cover-max` | three.js, `displayOk` but never two views | cover still up at 2.5 s, gone at ~5 s, layer open and flat; chip **no display** (outline, hollow dot, tooltip), reports end at `{ flat, no-display }`, never `live` |
| `chip-no-display` | three.js, the fake's display API answers "no display" | back to 2D at ~1.5 s; chip **no display** with the tooltip, report `{ flat, no-display }`; a click opens the menu, saves nothing |
| `chip-amber-debounce` | three.js, the fake's views on / off every 500 ms, then gone from 6.5 s | the dot stays green through the flips, turns amber 1-1.6 s after the views stop, and the chip stays live |
| `m-order` | `three-keyframes.html?pr=0.5` (a 640-wide mono store, 1280 SBS), a page-side `MutationObserver` recording the marker and `width` | `data-dxr-auto3d` set before the first write of the SBS width and removed after the write back to mono; on at the first `converting` report |
| `m-three` / `m-pc` | three.js keyframes / PlayCanvas meshes | marker `live` while converted; gone after `Ctrl+Alt+3`, back on re-enable, gone after the page's own `inline-3d` request (three) / a `pagehide` (PlayCanvas, in the same task); the page sees exactly set, remove, set, remove; every `converting` / `live` report made with it on, the `standdown` one with it gone |
| `g-trip` (v0.5.6 addition) | the same | marker set, removed, set, removed: off before the retry's session is requested, off after the block |
| `m-lifted-three` / `m-lifted-pc` | `dxr-lift` on the canvas / on its parent, from insertion | never converted: no session, layer, cover or marker; one `element is lifted` line; report `standdown` / `lifted` |
| `m-lifted-offer` | the same (three.js), product host, `offer` | not offered (chip hidden), report `standdown` / `lifted`, no session |
| `pc-webgpu-mesh` | `pages/pc-webgpu-mesh.html`: `pc-mesh.html` on a WebGPU device (`createGraphicsDevice` + `AppBase`, no globals) | as `b`, plus device and surface `webgpu`, found through the id trap, the eye projection the engine draws with = the fake's GL projection through `toClip`, and the go-live cover `<img>` holds a picture (GPU read-back) |
| `pc-webgpu-dyn` | the same, `?dyn=1`: the canvas is created by script and inserted only after the app exists | found through the trap its `getContext('webgpu')` armed, converts |
| `pc-webgpu-kill` | the same, frozen: `Ctrl+Alt+3` off, then on | as `b-kill` (commit model, out-cover holds a real picture, 3D again), plus the out-cover came from the GPU read-back (`outCoverVia: 'readback'`) |
| `pc-webgpu-near` / `-near-ctl` | `?near=1`: near 0.2, a magenta box 0.3 in front of the camera (clip z -0.33 in GL) | visible in both eyes (> 200 px each); the control (`gpuDepthRange: false`, the GL matrix as is) clips it in both |
| `pc-webgpu-gsplat` / `-cpu` / `-ctl` | `pages/pc-webgpu-gsplat.html`: a 3 × 3 grid of round splats from a PLY written in the page; the fake's `pixelAspect: 2` (a store pixel twice as wide as tall, as on the panel) | as `b`, convergence 5; the WGSL footprint shader patched (GPU sort: the compute projector; `-cpu`: the raster chunk); the white centre splat about 2:1 tall in store pixels in each eye, i.e. round on the display. The control (`pcFootprint: false`): nothing patched, about 1:1 (half height) |
| `s-webgpu-plain` | `pages/plain-webgpu.html`: a webgpu context on a canvas never inserted, no engine, product mode | the canvas carries the id trap; no core, no report, no timer at all |
| `three-webgpu` | `pages/three-webgpu-orbit.html`: `three-orbit.html` (plus a floor) on a real three r180 `WebGPURenderer`, ACES + sRGB output (the frame-buffer target path), three's own `setAnimationLoop`, one `render()` before `init()` | as `a-target` (convergence 5, source `target`), plus backend and surface `webgpu`, clear path `fb`, the eye cameras' `coordinateSystem` = the renderer's (WebGPU), the eye projection three draws with = the fake's GL projection through `toClip` (off-axis x / y kept), the pre-init `render()` passed through (three's own warning only), the go-live cover holds a picture (GPU read-back) |
| `three-webgpu-raw` / `-raw-ctl` | `?raw=1`: `NoToneMapping`, output = the working colour space (the direct path) | both eyes drawn (the generic shift check) and the same clear colour in both halves' corners; the control (`gpuClearFix: false`) leaves eye 0 wiped by eye 1's clear (no scene pixel in the left half) |
| `three-webgpu-pr2` | `?pr=2`: a 2560-wide mono store, a 1280-wide SBS store | converts, the page sees its pixel-ratio-2 canvas, no WebGPU validation error (with three's own size reads answered with the page's numbers, every submit is invalid) |
| `three-webgpu-fallback` | `?webgl=1`: `forceWebGL` (WebGL2 backend), no WebGPU adapter needed | converts; backend `webgl2`, surface `webgl`, `coordinateSystem` WebGL, the GL projection as is |
| `three-webgpu-near` / `-near-ctl` | `?near=1`: near 0.2, a magenta box 0.3 in front of the camera | visible in both eyes; the control (`gpuDepthRange: false`) clips it in both |
| `three-webgpu-kill` | the default page, frozen: `Ctrl+Alt+3` off, then on | as `b-kill`, plus `outCoverVia: 'readback'` |
| `three-webgpu-postfx` | `?postfx=1`: `PostProcessing` with `TSL.pass(scene, camera)`, product mode | last report `flat` with the `WebGPU PostProcessing` reason, never live, no layer, the canvas keeps its mono store |
| `p-three-webgpu` | the default page, product mode | goes `live` (engine three.js), one layer, never `flat` |
| `pc-cf-kill` / `pc-cf-webgpu-kill` | `pages/pc-cf-mesh.html?taa=0&vignette=0`: PlayCanvas 2.23, a `CameraFrame` with bloom (an HDR emissive sphere) and SSAO, WebGL2 / WebGPU, frozen | as `b-kill` (64 px shift, rig, convergence 8, commit model, out-cover, on again; WebGPU: `outCoverVia: 'readback'`), plus the split in `state()`: two chains on 640 × 720 targets, eye 0's compose into the left half (clears), eye 1's into the right (no clear); after the stand-down no split is left |
| `pc-cf` / `pc-cf-webgpu` | `pc-cf-mesh.html`: bloom + SSAO + TAA + grading + vignette on a grey clear colour; then the same page with `?bloom=0` | split with taa / bloom / ssao in both chains; the jitter non-zero and moving frame to frame; the sphere in both eyes, 64 px apart; the ring around it brighter than without bloom in BOTH eyes (~205 vs ~110); the vignette per eye (both edges of each eye alike, ~146, centre ~205) |
| `pc-cf-unsplit-ctl` | `pc-cf-mesh.html?taa=0`, `pcCameraFrame: false` (approach a: the CameraFrame left as is under `xrViews`) | a pair comes out, but the vignette is the pair's: each eye's seam side ~205, its outer edge ~146 |
| `pc-cf-toggle` | `pc-cf-mesh.html` on WebGPU; the page sets `cf.enabled = false`, then `true` + `update()` while converted | off: still converted, no split, the camera's `framePasses` empty, both eyes drawn by the plain path; on: the new pass split, same session, both eyes; no stand-down |
| `pc-cf-gsplat` / `-webgpu` | `pages/pc-cf-gsplat.html`: a unified gsplat (the 3 × 3 grid) under the viewer's CameraFrame configuration; fake `pixelAspect: 2` | split (bloom compiled out on the RGBA8 target, as on the viewer); 64 px shift; the white centre splat ~2:1 tall in store px in each eye (round on the display) |
| `ssv` / `ssv-webgl` | the REAL supersplat-viewer 1.37.0 (WebGPU / `?webgl`) on `.deps/gen/grid.ply` with post effects on; `maxSbsWidth` 1024 so the SBS store (1024) is narrower than the viewer's (1280), as on the panel | converts (found through the id trap); the viewer's own `canvas.width` writes recorded (~300) and the store kept 1024 × 720; the split; 51 px shift; round centre splat in each eye |
| `ssv-webgl-trap-ctl` | the same, `pcCanvasTrap: false` | the viewer pulls the store back to its own 1280 |
| `m-lift-live-three` / `m-lift-live-pc` | the lift attribute added while live | back to 2D in < 3 s through the staged path (out-cover, `mono frame drawn first`), no raw pair at close (commit model), marker removed after the close, no retry 3 s later |

**The commit model** (`window.__fakeXRTrackCommits`, cases `a-kill`, `b-kill`, `b-flip`). After
every frame's rAF callbacks (in a ResizeObserver callback, which runs after them and before paint)
the fake takes a 128×72 copy of the bound canvas: the frame this document commits. `close()` is
modelled as reaching the browser at once, so the frame committed before it, and the next few, are
what the browser shows unwoven; none may be a side-by-side pair unless the cover is up. It is a
model of the browser, not the browser: it catches an ordering that closes before the mono frame is
committed, and says nothing about the real compositor's timing.

**WebGPU cases** carry `webgpu: true`; when the browser has no WebGPU adapter they are **skipped**
with a loud line (the startup line names the adapter, or why there is none). Chrome 154 headless on
the Windows box needs no extra flag (no `--enable-unsafe-webgpu`): a localhost page gets the NVIDIA
Ampere adapter. A presented WebGPU canvas reads back empty, so the WebGPU pages provide
`window.__grabFrame()` (one frame drawn and read in its drawing task, after the engine's submit) and
the harness uses it instead of its between-frames `drawImage`. The commit model's `ResizeObserver`
snapshot runs after the frame's rAF callbacks, before present, so it works on WebGPU unchanged.

The harness proves the plumbing: detection, sizing, the per-eye matrices, counters, rig numbers,
the convergence estimate and its source, the turn-off ordering, and parity. It cannot prove the
weave, the join timing, or comfort. Those need the display (checklist above).

On Windows the harness uses the installed Chrome (`CHROME=` to override) with ANGLE D3D11. Chrome
is launched with `--disable-features=OpenXR,WebXR`: the fake provides `navigator.xr`, and PlayCanvas's
`xrCompatible` context otherwise makes Chrome load the box's REAL OpenXR runtime, which on a box
with DisplayXR installed can block context creation (every PlayCanvas page then times out on load).

## WebGPU (v0.6.0)

**What works.** PlayCanvas on a WebGPU device (`createGraphicsDevice(canvas, { deviceTypes: ['webgpu'] })`,
then `AppBase`) converts exactly like WebGL2: the same `xrViews` recipe, the same sizing, covers,
turn-off order, guard, rig and convergence. On WebGPU the engine wraps the passes in
`FramePassMultiView`, which falls through to one plain forward render when `device.xrSubImages` is
empty (only the engine's own `XRGPUBinding` path fills it; we never touch `app.xr`), and that forward
loop draws each `RenderView` with its own viewport and bind group, as on WebGL2. Gaussian splats work
on both WebGPU renderers (GPU sort, the default, and CPU sort), with the footprint fix. **three.js
`WebGPURenderer`** converts since v0.6.1 through a second renderer driver in `three-adapter.js`
([below](#threejs-webgpurenderer-v061)), on the same surface. Spark has no WebGPU path at all.

**The surface seam.** Everything in the core that depends on the canvas's graphics API sits behind one
object per canvas, `surface.js`, which the adapter returns from `ad.surface(st)`:

| | WebGL (`surfaces.gl`) | WebGPU (`surfaces.gpu`) |
|---|---|---|
| `limit()` | min of `MAX_TEXTURE_SIZE`, `MAX_RENDERBUFFER_SIZE`, `MAX_VIEWPORT_DIMS` | the **device's** `limits.maxTextureDimension2D` (a canvas texture over it fails `getCurrentTexture()`; there is no separate viewport maximum) |
| `flush()` | nothing | the engine's own `submit()`: at `postrender` PlayCanvas has encoded the frame but not yet submitted it (`frameEnd` does), and a read queued before that submit sees a cleared texture |
| `readEye` (out-cover) | `gl.readPixels`, synchronous, flipped (bottom-up) | `copyTextureToBuffer` of `getCurrentTexture()` in the drawing task, `bytesPerRow` 256-aligned, then `mapAsync`: no Y flip, `bgra8unorm` swizzled, premultiplied alpha divided out, forced opaque. Asynchronous |
| `readFrame` (go-live cover) | `false`: the core's own `drawImage` of the canvas, in the drawing task (unchanged) | the same GPU copy, of the whole store |
| `toClip(proj)` | the matrix itself | **the depth-range rule**, below |

**Both covers are GPU read-backs on WebGPU, never `drawImage` / `toDataURL` of the canvas.** Measured
(Chrome 154, P-W0 probe and this harness): after a WebGPU frame is presented, `drawImage()` of the
canvas into a (GPU-backed) 2D canvas comes back **empty**; inside the drawing task, after the engine's
submit, it is correct. So the go-live cover is read back first and the flip waits for it: the armed
canvas's mono frame starts the read, the flip happens on the first mono frame drawn after the read
landed (the cover is one frame old: a still either way), and a page that stopped drawing is asked for
one more frame (`flipIdle`). The out-cover is inserted once its read has landed (one frame later than
on WebGL, risk R-W6); a `drawImage` still taken in the drawing task stands in only if the read fails.
A canvas configured without `COPY_SRC` (hand-written WebGPU; PlayCanvas and three both set it), or in
an HDR format (`rgba16float`, PlayCanvas's choice when `(dynamic-range: high)` matches), gets no
read-back: one console warning, covers from the drawing task's `drawImage`.

**The depth-range rule.** The runtime's `XRView.projectionMatrix` is **GL clip space** (z -1..1): the
inline-3d session's graphics API stays WebGL unless the session asked for the `webgpu` feature, which
we do not (it is policy-gated and belongs to `XRGPUBinding`). WebGPU clips z to **0..1**. PlayCanvas
converts its own projections (`Camera.applyShaderProjectionTransform`) but uses `xrViews[i].projMat`
**as is**, because its `XRGPUBinding` path already hands out 0..1 matrices. So every eye projection
the shim hands a WebGPU engine goes through `surface.toClip`: **z row := (z row + w row) / 2**
(column-major `m[c*4+2] = (m[c*4+2] + m[c*4+3]) / 2`), the engine's own `_webGpuDepthRangeMatrix`.
Without it, everything nearer than 2 × near is clipped (an object at 1.5 × near is at clip z -0.33)
and half the depth range is wasted. Frustum maths read back from the matrix (`setXrProperties`' fov /
near / far) keeps the GL matrix. three's `WebGPURenderer` driver does the same, plus
`coordinateSystem` on its eye cameras (below).

**What is WebGPU-specific in the adapter.**
- **Gsplat footprint in WGSL**, at the device's `createShaderModule` (the GLSL rewrite is at
  `gl.shaderSource`). Two sites in playcanvas 2.22.3: the compute projector (GPU sort, WebGPU's
  default; `let J1 = focal / vz; let J2 = -J1 / vz * v.xy;`, the y focal from
  `viewportHeight × |(viewProj × (w1, 0)).y|` = `viewportHeight × |P[1][1]|`) and the raster chunk (CPU
  sort; the GLSL shape, with the view uniform block's `viewport_size` / `matrix_projection`, named
  `ub_view` in the final code). A site is patched only when all its anchors match; `footprint.seen /
  patched` counts it. Square pixels are unchanged (`|P[1][1]|`: a flipY target never flips the
  engine's single focal either).
- **Resize.** WebGPU's `setResolution` writes `canvas.width / height`, and the engine's `frameStart`
  re-creates its back buffer when `getCurrentTexture()` comes back another size, so the existing
  `setResolution` wrapper works unchanged and `GPUCanvasContext.configure` is never re-called. The
  engine's WebGPU `maxPixelRatio` (1 by default) shapes only the page's mono store; the SBS store is
  sized by the core from the element's device pixels.
- **Finding the app.** On WebGPU the context always exists before the AppBase constructor reads the
  canvas id (`createGraphicsDevice` → `initWebGpu` → `getContext('webgpu')`, then `new AppBase(canvas)`).
  The sentinel arms a canvas on its first `getContext('webgpu')` exactly as on a WebGL context, so a
  script-created canvas that is not even in the document is found (case `pc-webgpu-dyn`; the WebGL
  equivalent, `s-pc-dyn`, stays 2D). A webgpu context is also a signal for the page's opt-out. It
  starts only the **timer-free** part of the globals search (the microtask, `DOMContentLoaded`,
  `load`) and owns no sweep timer (its trap expires lazily), so a WebGPU page with no engine gets no
  sentinel timer (§3.3, case `s-webgpu-plain`).
- **The frame-rate guard** is unchanged: it is fed by the page's draws (`considerActivation`) and the
  session frames, not by the graphics API.

**Open, for the panel (P-W0 probe):** that a WebGPU canvas joins and weaves at all (R-W1: Dawn D3D12
writer, ANGLE D3D11 weave reader, the fence); HDR canvases (R-W3); whether `drawImage` of a
layer-bound WebGPU canvas is empty in the drawing task too (only the fallback depends on it); the
iframe off-axis error on superspl.at (Q5, a Blink fix, independent of WebGPU).

**P-W0 answers (2026-10-08, the real browser and runtime on the panel):** a WebGPU canvas bound to an
`XRDisplayLayer` weaves, including `rgba16float` with `toneMapping: 'extended'` (so HDR canvases are
not refused) and `alphaMode: 'premultiplied'`. An HDR canvas gets no GPU read-back (no 8-bit format
to copy): its covers come from the in-task `drawImage`, which works inside the frame task, before and
while bound (after present it returns the other eye, or nothing). The depth-range conversion matters
on the panel too: near content clips without it.

### three.js `WebGPURenderer` (v0.6.1)

`WebGPURenderer` is three's common `Renderer` over a backend: WebGPU, or the WebGL2 fallback
(`forceWebGL: true`, or no WebGPU adapter at `init()`). It is a different renderer class from
`WebGLRenderer`, not a backend of it, so `three-adapter.js` has a second **renderer driver**
(`st.common`). Everything else (finding the scene camera, the SBS store and the page's virtualised
sizes, replay of render-on-demand frames, the convergence target, covers, turn-off) is shared. One
driver serves both backends: the backend only picks the surface (`surfaces.gpu` from
`renderer.backend.device` + `renderer.getContext()`; `surfaces.gl` from the fallback's context) and
the clip space. Read and tested at three **r180** (the harness's pin); the API it relies on was read at
r178, r182, r184 and r186. **Supported: r178–r186.** r177 and older never announce a `WebGPURenderer`
on `__THREE_DEVTOOLS__` (nothing to find); a later revision is reported `flat` with its number until
it has been checked.

How each difference was resolved:

| | WebGLRenderer driver | WebGPURenderer driver |
|---|---|---|
| **init** | the renderer is ready when constructed | it announces itself from its constructor, before `init()` has chosen the backend. It is tracked (wrapped) at once, but a `render()` before `hasInitialized()` passes straight through (r178–r181: three forwards it to `renderAsync`; r182+: three throws, as without the shim), and `unqualified()` answers `WebGPURenderer not initialised yet`. `renderAsync()` (deprecated in r181, common on r178–r180 pages) is routed through the wrapped `render()` once initialised |
| **projection** | the runtime's GL matrix, or reversed-Z | the common renderer calls `updateProjectionMatrix()` (a **symmetric** frustum: the runtime's off-axis one lost) on any camera whose `coordinateSystem` differs from its own, or, with `reversedDepthBuffer` (r182+), that is not marked reversed. So the eye cameras get `coordinateSystem = renderer.coordinateSystem` and `_reversedDepth` before each `render()`, and the matrix in that system's clip space: reversed-Z when `reversedDepthBuffer`, else `surface.toClip` on WebGPU (clip z 0..1), else GL's as is. Frustum culling reads the same pair, so it culls what is drawn |
| **clears** | the scissor confines `autoClear` to the eye's half | a clear covers the **whole** attachment (WebGPU `loadOp: 'clear'` ignores the scissor), so it depends on the output path. **Default** (`fb`: tone mapping on, or the output colour space is not the working one, i.e. sRGB output): each `render()` draws into an intermediate frame-buffer target (cleared whole), then an output pass with `autoClear` off samples it at `screenUV` into the renderer's viewport and scissor on the canvas, which is loaded, never cleared. Two renders into two halves just work. **Direct** (`NoToneMapping` + output = working colour space): the scene draws straight to the canvas, and eye 1's clear would wipe eye 0. Eye 0 then clears with the scissor off (one clear colour in both halves; its draw is still confined by its viewport) and eye 1 draws with `autoClearColor = false` (depth / stencil still clear). The path is read per draw (`needsFrameBufferTarget`, r182+; `_getFrameBufferTarget()` before) and shown as `clearPath` in `state()` |
| **size reads** | the page's numbers, even inside a render | three itself reads `getDrawingBufferSize`, `getViewport`, `getPixelRatio` … (its frame-buffer target, the backend's colour buffer, the screen nodes the output pass samples with). Inside the shim's own calls those see the **real** store; the page's own calls still see its mono one |
| **frame counter** | the eye pair shares one `info.render.frame` | nothing to do: the common `Info` has no `render.frame`, and FRAME-scoped node updates advance only with three's own animation loop, so both eyes already share a frame |
| **post-processing** | per-eye twins of an `EffectComposer` chain | **not split**: a full-screen pass whose render (nested, in `PassNode.updateBefore`) drew the page camera into a target is `PostProcessing`; reported `flat` with the reason, and a converted canvas that switches it on stands down |
| **readback** | `readPixels` in the drawing task | WebGPU: the surface's GPU copy (three configures `COPY_SRC`, `alphaMode` premultiplied by default and submits each pass in `finishRender`, so `flush()` is a no-op); the WebGL2 fallback: `readPixels`, as `WebGLRenderer` |

Not done: `ArrayCamera` / multi-view (`renderer.render` with an `ArrayCamera` stays flat per the
existing rule), WebXR on the WebGPU renderer (`renderer.xr` presenting stands down, as on WebGL), and
three's `PostProcessing` (above). Spark is WebGL-only.

## PlayCanvas `CameraFrame` (v0.6.2)

`CameraFrame` (`extras/render-passes/camera-frame.js`) is how PlayCanvas 2.x pages get post-processing,
and what superspl.at's viewer builds whenever a scene's settings turn on any post effect or high-precision
rendering. It sets `camera.framePasses = [FramePassCameraFrame]`, and the frame graph then adds those
passes instead of the camera's own forward passes (`scene/renderer/forward-renderer.js`
`buildFrameGraph`, `renderAction.useCameraPasses`). Read at playcanvas **2.23.0** (the viewer's own
devDependency) and 2.22.3; the two differ only in bloom's threshold and the scene-half source.

**Why the engine's own XR path is not enough (approach a, measured).** The chain's scene passes are
`RenderPassForward`s, so under `xrViews` they already loop over the views
(`renderForwardInternal`: one draw per `RenderView`, each with its viewport and bind group) and draw
the pair into the scene target. But that target is sized to the canvas
(`setupRenderPasses`: `sceneOptions.resizeSource = cameraComponent.renderTarget`, null = the back
buffer), and every pass after it is one full-screen quad over the pair: one vignette and one
fringing centred on the pair, sharpening and bloom across the seam, SSAO reconstructing with the
pair's aspect, and TAA reprojecting through ONE camera matrix: under `xrViews` the renderer applies
no jitter and never calls `Camera._storeShaderMatrices` (`renderer.js` `setCameraUniforms`), so the
resolve reads stale matrices. The control case `pc-cf-unsplit-ctl` (TEST ONLY `pcCameraFrame: false`)
shows it: a pair comes out, with the vignette's dark edges on the outside of the pair only.

**What it does (approach c, with b's per-eye targets).** The whole chain runs once per eye, each eye
into its own targets of the **eye's** size:

- **Two chains.** Eye 0 is the page's own `FramePassCameraFrame` (A). Eye 1 is B, a second instance
  built from A's own class (`new A.constructor(app, A.cameraFrame, camera, A.options)`, no engine
  namespace needed). Both get `sceneOptions.resizeSource` = the eye size; every other target of the
  chain (SSAO, TAA history, the half-res scene, bloom, DOF) resizes from the scene texture, so
  memory is two half-width chains, about one mono chain. A rebuild of either (an option or layer
  change: `update()` → `reset()` → `setupRenderPasses()`) is re-adopted through a per-instance
  wrapper on `setupRenderPasses`.
- **The page's settings drive both.** `CameraFrame.update()` writes into `renderPassCamera`; once per
  frame it is applied to B with `renderPassCamera` swapped for the call, so bloom, grading, vignette,
  TAA, SSAO and DOF are always the page's own. A's `layersDirty` is passed on to B.
- **Ordering.** `camera.framePasses = [eye 0, eye 1]`: two disabled `FramePass`es (never rendered; the
  frame graph runs their `frameUpdate` and adds their before passes, `frame-graph.js`
  `addRenderPass`) holding `[marker, A]` and `[marker, B, end marker]`. The markers are `FramePass`es
  of the engine's own base class (A's prototype parent) whose `execute` runs at render time, in pass
  order: `device.xrCurrentViewIndex` = the eye, so the forward renderer draws only that view (the
  mechanism the engine's WebGPU multiview path uses, `frame-pass-multi-view.js`), with the view's
  viewport set to the eye target; on WebGPU the whole list still sits in the engine's
  `FramePassMultiView`, which falls through to a plain render. A marker on each compose pass's
  `afterPasses` moves the views back to the eye's half of the store for the after pass (the layers
  after the post chain, e.g. UI). The end marker restores the view index.
- **Compose into the half.** Each compose pass draws its quad into its eye's half
  (`RenderPassShaderQuad.viewport` / `scissor`). Eye 1's compose clears nothing (a WebGPU load-op
  clear ignores the scissor and would wipe eye 0); the frame graph's `compile` then makes eye 0's last
  pass on the back buffer store. The camera-use flags make the pair one camera use: the scene
  `prerender` event and the camera's before passes once, from eye 0; `postrender` from eye 1.
- **TAA.** Each eye has its own history (B owns its `RenderPassTAA`). The engine's Halton jitter
  (same sequence and amplitude, in eye-target pixels) is added to both eye projections, and before
  each eye's resolve the camera carries that eye's previous / inverse view-projection and jitters
  (`render-pass-taa.js` `before()` reads `_viewProjPrevious`, `_viewProjInverse`, `_jitters`).
- **A page that changes its CameraFrame** is followed on `prerender`: a new pass is split again, a
  disabled one leaves the plain `xrViews` path. `CameraFrame.disable()` destroys "its" frame passes,
  i.e. the two proxies: eye 0's destroys A as the page asked, and B with it (case `pc-cf-toggle`).
- **Stand-down** puts `camera.framePasses = [A]` back, A's targets back to the canvas size, its
  compose back to full screen, and destroys B (re-asserting the camera's scene-depth flags, which B's
  `reset()` clears and A still needs).

**Gaussian splats under a CameraFrame.** The splats are drawn by the scene pass, per eye like any
mesh. The footprint fix is unchanged (device-level, `gl.shaderSource` / `createShaderModule`), but
**2.23 fixed the footprint upstream**: `gsplatCorner` (GLSL and WGSL) now takes
`focal = viewport_size.xy * (projMat00, projMat11)`, and the WebGPU compute projector a separate
`focalY` (`compute-gsplat-projector.js`). The patch still sees its `J2` marker but none of the 2.22.3
anchors, so it patches nothing (`footprint` `0/1` on WebGL2, `0/2` on WebGPU), and the splats come
out round in each eye on the engine's own maths. The roundness is asserted on the pixels (cases
`pc-cf-gsplat*`, `ssv*`); on 2.22.3 pages the patch is still what makes it (`pc-webgpu-gsplat*`, `c`).

**The real viewer in the harness.** `@playcanvas/supersplat-viewer@1.37.0`'s standalone build (its
`public/`, engine bundled) is served from `.deps/supersplat-viewer/`, pointed at a generated 3 × 3
splat grid (`.deps/gen/grid.ply`, written by `run.mjs`) with every post effect on in its settings
(`pages/ssv-settings.json`): it builds its CameraFrame exactly as superspl.at does, on WebGPU (its
default) and WebGL2 (`?webgl`). With `highPrecisionRendering` off it asks for an RGBA8 scene target
(`renderFormats = []`), on which the engine compiles bloom out: sharpening, grading, vignette and
fringing run, per eye.

**Limits.** SSAO keeps the engine's screen-space maths over a squeezed eye (its sample disc uses the
target's pixel aspect, half the eye's frustum aspect). `renderTargetScale` < 1 scales both eye
targets (the views' viewports follow the actual target size). A CameraFrame on a camera with a
`renderTarget`, or a non-full `rect`, is not a case the adapter takes (one camera to the canvas). TAA
under motion (the per-eye reprojection) was checked by reading `taaResolve` and by the jitter moving
per frame in `state()`, not on pixels; image quality under motion is the panel's call. Test switches
(harness only): `pcCameraFrame: false` (unsplit, approach a), `pcTaaJitter: false`, `pcCanvasTrap: false`.

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

**Headless, v0.7.0 (Babylon.js), Windows, ANGLE D3D11 + WebGPU:** 28 new cases in `test/cases/babylon.mjs`
plus `pivot-bjs-orbit` / `pivot-bjs-yaw`, all green on babylonjs **9.32.0, 8.56.2 and 7.54.3** (the UMD
build swapped under the same pages):
- **Basics.** `bjs`, `bjs-rh`, `bjs-est-rev`, `bjs-global`, `bjs-gpu`: the pair at the fake's shift
  (residual 0.00), the page's FOV on the rig, the convergence on the target / the scene.
- **Display rig and pivot.** `bjs-display`, `pivot-bjs-*`.
- **Turn-off.** `bjs-kill`, `bjs-gpu-kill`: mono first, the out-cover, on again on a page that stopped
  drawing.
- **Sizing.** `bjs-dpr2`, `bjs-cap`, `bjs-gui`: `scene.pick` still hits at device pixels and under the cap.
- **The rest.** The partial viewport (`bjs-vp`), the per-eye G-buffer (`bjs-gbuf` + A/B), eye targets
  on WebGL and WebGPU (`bjs-ss`, `bjs-gpu-ss` + A/Bs), post-processes (`bjs-fx`), the 2D reasons
  (`bjs-flat-*`), product mode (`bjs-product`, `bjs-block`, `bjs-trap-clean`).
- **Per-version notes.** The engine option `useReverseDepthBuffer` is 9.x's, so the page sets the
  property, which 7.x / 8.x have too. On 7.54.3, `bjs-rh`'s two reads can differ by 1 LSB at one
  pixel (`unstableBytes`), while 90 reads through one readback canvas never change.

Full pass with the three.js and PlayCanvas cases: see the PR.

**On the panel** (Windows box, DisplayXR Browser via `launch.cmd`, 2026-11-06, Byungju):
- **The default playground** (`playground.babylonjs.com`, Babylon 9.33.3, UMD, the constructor trap)
  converts. At its own CSS-pixel store (`SBS 636x495`, eye 318 px) it was jagged and read flat;
  now 1910 × 1485 at the element's device pixels.
- **`#VW8IG3#156`** (GIRSM global illumination on the geometry buffer) converts and reads right.
- **`#8R5SSE#587`** (IBL shadows) first showed different ground shadows per eye; after the history
  copy and the eye targets, "much better".
- **Nike By You**, the shoe customizer (`nike.com/u/custom-ja-3-by-you-10002432/5274852793#Builder`
  and `custom-sabrina-4-by-you…`, Babylon 9.6.2, ESM, the constructor trap):
  - converts at SBS 3072 × 1384 under the cap, with its camera viewport `(0, 0.39, 1, 0.61)` under the
    builder UI;
  - works normally, rotating and customizing included, with the eye targets. Before them the eyes looked
    subtly different ("see-through").
- **Not seen yet.** WebGPU pages, a fullscreen GUI, gizmos.

**Not verified.** Babylon 7.x / 8.x on the panel (headless: green on 7.54.3 and 8.56.2; the panel saw
9.6.2 and 9.33.3). The corpus (`corpus/sites.json`, `babylon-playground` and `babylon-home` now in the
engine group) has not been re-run.

**Headless, v0.6.5 (one-axis framing is not jitter, #231), Windows, ANGLE D3D11 + WebGPU:** 128 cases, of
which 3 are new: `e-postfx-bob`, `e-postfx-spring` and `e-postfx-parallax`.
- **Full pass.** 126 run, 2 skipped (`c` / `d`: no `ports_25.sog`), 125 green. `a-legacy` fails as before,
  with the same numbers, on this Windows box only.
- **On v0.6.4.** All three new cases stay 2D with the jitter reason: the bug.
- **TAA still caught.** The TAA cases (`e-postfx-jitter`, `-taa`, `-taa-late`, `-taa-short`, `-taa-half`)
  pass unchanged. With the rule fed synthetic offsets, a Halton TAA is caught at frame 4–5 (each start
  phase), a 4-sample rotated grid at 6, random jitter at 5.

**Headless, v0.6.4 (a TAA jitter left set, #226), Windows, ANGLE D3D11 + WebGPU:** 125 cases, of which 5
are new: `e-postfx-taa`, `e-postfx-taa-late`, `e-postfx-taa-short`, `e-postfx-taa-half` and `e-postfx-pan`.
- **Full pass.** 123 run, 2 skipped (`c` / `d`: no `ports_25.sog`), 122 green.
- **The second look.** The first cut of the rule missed two TAAs: `e-postfx-taa-short` stays live on it,
  and `e-postfx-taa-half` converts. Both pass with the rule above. Re-run after it:
  - the real pages below, driven like a visitor, at DPR 1, at DPR 2, and at the panel's DPR 3 and
    725×585 (SBS 3072×2700, as on the panel): live in every sample, no jitter stand-down;
  - threejs.org `webgl_postprocessing_taa` and `_ssaa` stay 2D with the jitter reason, and
    `webgl_postprocessing_unreal_bloom` converts.
- **The one red is not from this change.** `a-legacy` fails as before, with the same numbers, and only
  on this Windows box: the #222 review ran 120/120 on macOS, `a-legacy` included.
- **On v0.6.3.** `e-postfx-taa` converts and `e-postfx-taa-late` stays live: the bug.
  `e-postfx-pan` passes there too, and still passes: a slow pan is not taken for jitter.
- **The real pages, headless with the fake session.** `visual-learning.app/sandworm`, `/strandbeest`
  and `/robotic-bee`:
  - 30 s of their tours each: all three stay live, with no jitter stand-down;
  - about 70 s each, driven like a visitor (view keys 1–6, a drag, the wheel, X-ray on and off, pause):
    live in every once-a-second sample after going live.
- **On the panel** (Windows box, DisplayXR Browser via `launch.cmd`, 2026-11-03), with the first cut and
  again with the final rule: all three convert and read right, and `flatReason` stays `null`. This is
  strandbeest's and robotic-bee's first panel check. With the final rule, threejs.org
  `webgl_postprocessing_taa` and `three-postfx.html` (served locally) with `?view=taa`,
  `?view=taa&rtScale=0.5` and `?view=taa-short` stay 2D, and `?view=pan` converts.

**Headless, v0.6.3 (three.js view windows + mirroring chains, #221), Windows, ANGLE D3D11 + WebGPU:**
120 cases, 11 of them new:
- view windows: `e-postfx-view0`, `e-postfx-shift`, `e-postfx-crop`, `e-direct-shift`, `e-postfx-jitter`
  and `e-postfx-miss`;
- mirroring chains and real parallax: `e-postfx-eyes`, `e-postfx-mirror`, `e-postfx-mirror-overlay`,
  `e-postfx-mirror-ctl` and `e-postfx-mirror-eyes`.

Results:
- **Full pass.** 118 run, 2 skipped (`c` / `d`: no `ports_25.sog`), 117 green.
- **The one red is not from this change.** `a-legacy` fails its rig-parity check (convergence 8.0747
  vs 8.0413; the frame is still byte-identical). It failed identically on `main` before this change,
  so it broke after the v0.6.2 run.
- **Controls.**
  - Without `applyView`, the marker checks of `-shift`, `-crop` and `e-direct-shift` fail, and
    `-crop`'s pair shift is 64 px, not 128. The generic 64 px check still passes on `-shift`, which
    is why the marker check exists.
  - With the v0.6.2 adapter, `e-postfx-view0` never converts and logs the sandworm page's exact 2D
    line, and `e-direct-shift` never draws a stereo frame.
- **The real page.** `visual-learning.app/sandworm` (three r186), headless with the fake session:
  - it converts: `SBS 1600x900`, 1200 stereo frames, no flat frame after the eyes, convergence from
    its `camera.lookAt`;
  - its own crop zoom (`__STAGE.setCrop(2, …)`) stays live in stereo;
  - its mirroring chain is found on the first chain frame (r 0.88 mirrored vs 0.01 as drawn);
  - with the fake's eyes 2 units apart, the pair shifts +32 px. That is the skew's +80 less the
    parallax, the same sign as any unmirrored page. With `chainMirror: false` it shifts −34 px:
    pseudoscopic, the panel's report reproduced.
- **The same site's `strandbeest` and `robotic-bee`.** Both frame with a per-shot
  `setViewOffset(w, h, -sx, -sy, w, h)` and do not mirror. With v0.6.2 they stayed 2D with
  sandworm's exact line. Now:
  - both convert, and the probe takes them as not mirrored (r 0.56 vs −0.06, 0.93 vs 0.00);
  - with real parallax the pair is the right way round. strandbeest with eyes 0.06 apart reads
    +55 px (`'force'`: −55); robotic-bee with eyes 0.2 apart reads +41 px.

**On the panel (Windows box, DisplayXR Browser via `launch.cmd`), sandworm, 2026-11-02:**
1. **Before the mirror fix.** It converted, but the pair read as pseudoscopic. `three-keyframes` and
   `webgl_postprocessing_unreal_bloom` read right on the same panel, and removing `#app`'s CSS
   scale changed nothing.
2. **First probe.** It never reached a correlation (`mirrorCorr` null) and fell back to not
   mirrored.
3. **Second probe (re-draws, last seed).** It found the frame's last seed blank (above).
   `chainMirror: 'force'` read right, which confirmed the eye conjugation.
4. **Final probe (main seed).** It decides on its own, and the tester confirmed that the pair reads
   right.

**Headless, v0.6.2 (PlayCanvas CameraFrame, P-W1c), Windows, ANGLE D3D11 + WebGPU (NVIDIA Ampere):** 109
cases (98 + 11 new: `pc-cf-kill`, `pc-cf-webgpu-kill`, `pc-cf`, `pc-cf-webgpu`, `pc-cf-unsplit-ctl`,
`pc-cf-toggle`, `pc-cf-gsplat`, `pc-cf-gsplat-webgpu`, `ssv`, `ssv-webgl`, `ssv-webgl-trap-ctl`), 107 run,
2 skipped (`c` / `d`: no `ports_25.sog`), no WebGPU case skipped, one full pass: 105 green, the two
`pc-cf-*-kill` cases failing only the out-cover's flipped-orientation test (the cover was a real picture,
luma std 15, but the page was up-down symmetric). A dark bar low in `pc-cf-mesh.html` fixed that and
those two plus `pc-cf` / `pc-cf-toggle` (same page) were re-run green; the rest was not re-run. Every
existing case, all WebGPU ones included, passes unchanged. The real supersplat-viewer 1.37.0 converts
on both backends with its CameraFrame split. Nothing on the panel: the real superspl.at page is the
next check.

**Headless, v0.6.1 (three.js WebGPURenderer, P-W1b), Windows, ANGLE D3D11 + WebGPU (NVIDIA Ampere):** 98
cases (87 + 11 new: `three-webgpu`, `-raw`, `-raw-ctl`, `-pr2`, `-fallback`, `-kill`, `-near`, `-near-ctl`,
`-postfx`, `p-three-webgpu`, `p-webgpu-api`; `p-webgpu` now runs the stub at an unverified revision),
96 run, 2 skipped (`c` / `d`: no `ports_25.sog`), no WebGPU case skipped, one full pass. Every new case
passes and each control shows what its fix prevents (`-raw-ctl`: eye 0 wiped; `-near-ctl`: the near box
clipped; with three's own size reads answered with the page's numbers, `-pr2` logs invalid command
buffers). One failure, outside the changed code: `s-cost`'s div.id benchmark at +6.2 % (bound ±5 %),
the known box noise. three was run at r180 only (the harness pin); r178–r186 were checked by reading
their sources. Nothing on the panel.

**Headless, v0.6.0 (WebGPU, P-W1a), Windows, ANGLE D3D11 + WebGPU (NVIDIA Ampere, no extra flag):** 87 cases
(78 registered on `main`, whose count above said 76, + 9 new: `pc-webgpu-mesh`, `-dyn`, `-kill`, `-near`, `-near-ctl`, `-gsplat`, `-gsplat-cpu`,
`-gsplat-ctl`, `s-webgpu-plain`), 85 run, 2 skipped (`c` / `d`: no `ports_25.sog` on the box), no WebGPU
case skipped. Every WebGPU case passes, and each control (`-near-ctl`, `-gsplat-ctl`) shows exactly
what its fix prevents. Two flakes, neither in the changed code: `a-kill` once committed only 2 frames
after `close()` (the release took 490 ms on a busy box; it passes on rerun), and `s-cost`'s div.id
benchmark reads the shim 6-11 % FASTER than the control, which `origin/main` reproduces on the same
box (-6.4 %). The full pass was interrupted once by the headless browser exiting during `g-retry`;
the remaining 55 cases were rerun. Nothing on the panel yet: the P-W0 probe comes first.

**v0.5.7 (corpus follow-ups, 2026-10-04): not yet run.** Adds `p-webgpu` (76 cases). Validation is
pending a quiet-box window.

**Headless, v0.5.6, Windows, ANGLE D3D11:** 75 cases (67 + `m-order`, `m-three`, `m-pc`,
`m-lifted-three`, `m-lifted-pc`, `m-lifted-offer`, `m-lift-live-three`, `m-lift-live-pc`; marker
assertions added to `g-trip` and `chip-layout`), 0 failures in one full run. Nothing here has run against
the browser's lift code: the cases set `dxr-lift` themselves.

**Headless, v0.5.4 (P0.3), Windows, ANGLE D3D11:** 65 cases (63 + `d-pc`, `s-late-canvas`); new assertions: no
detection after a stand-down (`d`, `d-pc`), Spark's `renderSize` = the eye (`spark`, `spark-eyes`),
one settle line (`spark-room-subject`), no sentinel timer when a canvas is added after load on a
page that never asks for WebGL (`s-late-canvas`: the canvas-id trap's 10 s expiry sweep owns a timer
only once a WebGL context exists; before that a trap expires lazily, on its own id read, the next
mutation or the next `getContext`).

**Headless, v0.5.2 (P0.2), Windows, ANGLE D3D11:** 60 cases (52 + `g-loading`, `g-loading-long`, `g-steady`, `spark-est`, `spark-room`,
`chip-no-display`, `chip-amber-debounce`, `a-dpr2`); `a` pins `eyeScale` 0.5 to stay
byte-identical with `a-legacy`.

**Headless, v0.5.1 (P0.1 follow-ups), Windows, ANGLE D3D11:** 48 cases (19 earlier + 10 sentinel +
8 guard + 11 chip); `a` / `a-legacy` still byte-identical; `node build.mjs --check` clean.
**+ post-processing (`e-postfx`) and Spark (3 cases, `spark*`)**: pass with the one-frame-per-pair
change; `spark-eyes` fails without the change. Not yet on the panel: a Spark
page (`https://sparkjs.dev/examples/hello-world/index.html`; World Labs Marble worlds in
`https://sparkjs.dev/examples/streaming-lod/index.html`, streamed `.rad` LoD).

**Not yet on the panel (v0.5.2), and open:**

- **The chip's woven safety is not judged**: whether it composites as crisp 2D over the woven
  tile, at every corner and with the menu open. This is the blocking gate before anything ships.
- **The chip in fullscreen takes no clicks** (headless: Chromium paints the fresh popover over the
  fullscreen canvas but hit-tests the fullscreen element). Check on the panel; if confirmed, the
  fullscreen chip is status-only (exit fullscreen to change it) unless the host draws it natively.
- **R1, still a gap for one order**: a script-created canvas inserted and handed to
  `new Application()` in the same task (`s-pc-dyn`) stays 2D: the observer's callback is a
  microtask, and PlayCanvas reads `canvas.id` before `getContext`. The launcher order (insert, then
  create the app in a later task) is now covered (`s-pc-dyn-defer`). Closing the rest still needs the
  upstream `AppBase` announce hook, which should become **blocking**, not optional.
- The guard's warm-up and retry-once (v0.5.2) are headless-verified with synthetic loading pages
  only (`g-loading`, `g-loading-long`); not yet re-run on the Spark pages on the panel.
- The device-pixel eye (v0.5.2) is headless-verified at an emulated DPR 2 (`a-dpr2`); whether Spark
  hello-world now reads sharp on the 2.5× panel, and what the larger store costs in frame rate, need
  the panel.

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
real runtime views. The cover timing against the real join. Whether `depth` 0.5 (camera rig; one panel pass says so) and the automatic
convergence are comfortable. Frame rate. PlayCanvas on real sites (UMD builds, the examples
browser's iframes, supersplat-viewer). The gsplat sort artefacts from sorting around the page
camera rather than the eyes.

Measured earlier on a weave-less instance, and handled: a canvas with a layer bound is withheld
from the page and never woven (a blank tile), and `getDisplayInfo()` resolves `null` with no
rendering modes, so the script goes back to 2D within ~1.5 s there. `drawImage()` from a bound
canvas also returns an empty image, which is why the cover is a still.

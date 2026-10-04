# auto-3D for existing three.js and PlayCanvas pages (prototype)

Turns an ordinary, already-published three.js or PlayCanvas page into a woven glasses-free-3D
window in the DisplayXR Browser, **with no change to the page**: no SDK import, no WebXR, no source
edit. It is a prototype for measuring coverage on real sites, in the same spirit as
`tools/immersive-shim/` (which does the same for WebXR `immersive-vr` pages). It is not a product
and must not ship as one. How it would fold into the browser: [`docs/proposals/auto3d-browser-integration.md`](../../docs/proposals/auto3d-browser-integration.md).

## Architecture: a sentinel, one core, one adapter per engine

The sources are **part files**, each one top-level `function dxr…`, and `build.mjs` (Node, no
dependencies, no bundler: concatenation plus a version stamp) assembles them into `dist/`:

```
dist/auto3d-sentinel.js   (function (cfg, cap) { sentinel.js ... return dxrSentinel(cfg, cap); })
dist/auto3d-core.js       (function (cfg, cap, S) { core.js guard.js chip.js dev.js
                            three-adapter.js playcanvas-adapter.js ... return dxrCore(cfg, cap, S); })
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
        convScale (0.05..20, 1 = automatic), dev, engines: { three, playcanvas }, test }   // frozen
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
   in which one was read, a one-shot setter for that id on `Object.prototype`).

Plus one `MutationObserver` on the document (not page-visible; it arms `<canvas>` elements as they are
added, see R1 below) until an app is found or the first mutation after load + 10 s.

Plus the value-only symbol marker. After an engine is found the core adds what converting needs:

5. per-instance wrappers on the renderer / app (three.js `render` / `setSize` / getters, plus
   `Object3D.prototype.lookAt` wrapped when the first Scene is announced; PlayCanvas
   `GraphNode.prototype.lookAt` and the camera's `xrViews`), and the canvas `width` / `height`
   virtualisation while converted;
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
content trimmed). The sentinel checks it on the first WebGL context and when an engine is found:
the core is never loaded, one `{ status: 'optout' }` report, one console line. Inserted later, the
core refuses to activate, and a live canvas goes back to 2D within 30 session frames.

A user `block` outside dev never loads the core (the sentinel stays detect-only, and reports
`{ status: 'off', engine }` once when it finds one). The `requestSession` wrapper stays installed
under block. The dev extension
emulates the host with `host-dev.js` over the page's `localStorage` (the v0.4 behaviour, including
the v0.3 single-depth migration); `window.__dxrAuto3DTestCfg` is read only there, and only in dev.

| file | owns |
|---|---|
| `sentinel.js` | `dxrSentinel(cfg, cap)`: the DisplayXR check, the marker, `S.intrinsics` (built-ins snapshotted before page scripts: `attachShadow`, `showPopover`, `elementsFromPoint`, the canvas `width`/`height` and `Element.id` descriptors), the `navigator.xr.requestSession` wrapper (a page that asks for `inline-3d` / `immersive-*` owns XR; our own requests use `S.xrRequest`), **engine detection** (`__THREE_DEVTOOLS__`, the `getContext` wrap, the PlayCanvas routes incl. the parse-time canvas observer), the page's `<meta>` opt-out (`S.optedOut()`), `S.settle(canvas)` (a canvas went live: the PlayCanvas search stops unless another canvas has a WebGL context) and `S.disarm()` (the core stands down for good: every trap and poll off, for good), and the **lazy** core: `cap.loadCore()` only when an engine is found (three.js: inside the listener for its first `register` / `observe` event; PlayCanvas: when an app is found). On a page with no engine the core is never parsed. |
| `core.js` | `dxrCore(cfg, cap, S)`: everything that is not about one engine. **Document state:** one inline-3D session per document, standing down for good when the page owns XR; `site` (this document's copy of the host's decision, depths, rig, convScale) and `on()`. **Lifecycle:** activate → armed → flip on the page's next draw → per-session-frame → stand; `turnOff(st, reason)` (fade to flat, out-cover, staged stand) shared by the site switch and the frame-rate guard. **Sizing:** the side-by-side (SBS) rule (the SBS store = the element's full device size, each eye half of it, whatever store the page keeps; each axis capped on its own: 3072 wide, and the GL limits; see [Tuning](#tuning-keys-v052)) and the `canvas.width` virtualisation helper. **Rig builder:** the camera rig by default, the display rig on `Ctrl+Alt+P` (see [Rigs](#rigs-camera-by-default-display-on-ctrlaltp)), pushed every frame. **Convergence:** the page's explicit target when it has one, else the estimator (below). **Covers and depth fade:** an `<img>` still of the last mono frame over the canvas for 1.2 s after the layer (the `firstWoven` hold, [woven-canvas rules](../../docs/woven-canvas-rules.md) rule 5), a depth fade in after it and out before a turn-off, and an `<img>` out-cover read back from WebGL for the 3D→2D swap (see [Transitions](#transitions-covers-and-the-depth-fade)). **Turn-off order:** mono frame first, layer released after it is committed (below). **Control:** `ctl` (`status`, `setEnabled(on, {remember})`, `setRig`, `setDepth`, `nudgeFocus(-1\|0\|+1)`, `reset`, `onChange`), shared by the chip and the dev hotkeys, and `notify()`, which fans every change out to the chip, the dev HUD and `cap.report`. Tuning constants (`T`) are overridable only from `cfg.test` in dev. |
| `guard.js` | `dxrGuard(core)`: the frame-rate guard (see [The guard](#the-frame-rate-guard-the-gl-clamp-reduced-motion)). Hooks: `draw` (the page's 2D rate, from the top of `considerActivation`; also the re-measure after a trip with no baseline), `onFlip`, `tick`, `tripped` (`statusOf` → `'guard'`), `measuring` (`statusOf` → `'converting'`) |
| `chip.js` | `dxrChip(ctl, S)`: the "3D" chip and its menu (see [The chip](#the-3d-chip)). Uses only `ctl` and `S.intrinsics`; the core calls `frame(st)` per session frame and exposes it as `core.chip` (`__dxrAuto3D.chip()` in dev). While the site is off the core still qualifies a **candidate** canvas (`considerCandidate`) so offer mode has something to offer 3D on |
| `dev.js` | `dxrDev(core, ctl)`, only when `cfg.dev`: the HUD, the Ctrl+Alt hotkeys, `window.__dxrAuto3D` (`state()`, `probe()`, `set()`) |
| `host-dev.js` | `dxrDevHost(loadCore)`: the dev extension's stand-in for the browser host, over `localStorage` |
| `three-adapter.js` | `dxrThree(core)`: the three.js prototype's own code, unchanged in behaviour. Fed by the sentinel's `__THREE_DEVTOOLS__` listener (`observe`, `register`); per-instance wrapping of `render` / `setSize` / getters, per-eye render into each half, flat HUD / post passes, render-on-demand replay, reversed-Z |
| `playcanvas-adapter.js` | `dxrPlayCanvas(core)`: takes the app the sentinel found (`consider(app, how, ns)`), drives the page's camera through the engine's `RenderView` path, resizes the store through `device.setResolution`, supplies bounds from `render` / `model` / `gsplat` components, and applies the gsplat footprint fix |
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
`afterActive`, `firstDraw`, `redraw`, `restore`, `flipIdle`, `wake`, `describe`, `gl`, plus `readEye` and
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
| post-processing chain: the scene into a render target, full-screen passes, a final pass to the screen (EffectComposer, pmndrs postprocessing, a page's own) | **3D** through per-eye render-target twins (below). Harness case `e-postfx`; **not yet seen on the panel** |
| a chain whose scene pass uses `setViewOffset` (TAA / SSAA jitter) | **2D** (the seed is not recognised) |
| `WebGPURenderer` | **2D**, reported `flat` with the reason `WebGPURenderer — the prototype drives WebGL renderers only` (v0.5.7; before, a bare `idle`). Nothing on the renderer or its canvas is touched. Harness case `p-webgpu` |
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
  half its size, not a cube / 3D / array target, no `setViewOffset`) starts the chain. The left eye
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
same frame.

### PlayCanvas (engine 2.x, WebGL2)

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
   module scripts run) and on its first WebGL `getContext`. A trap comes off once an app is found,
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

## Try it on the display (Windows box)

**A — in your own DisplayXR Browser (recommended).** `chrome://extensions` → *Developer mode* →
*Load unpacked* → select this folder. Then open or reload a three.js / PlayCanvas page. The
extension loads the committed `dist/auto3d-dev.js`; after editing a source file run
`node build.mjs` here, then reload the extension.

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
| a supersplat-viewer page, `…/scene/<id>?webgl` (the query starts with `?`, not `&webgl`) | PlayCanvas: an ESM app found through the canvas-id trap (route 2), `autoRender = false`. Without `webgl` the viewer picks WebGPU and stays 2D. A standalone copy of the viewer (its built `index.html` served locally) needs the scene's `settings.json` next to it (`./settings.json`); without it the viewer never starts |
| the PlayCanvas engine examples, `loaders/glb` | PlayCanvas: the camera alternates perspective / orthographic every 2 s (3D, then 2D; see below) |

### Hardware verification checklist (for the tester)

1. **It converts.** The console shows `[dxr-auto3d] three.js r… renderer found` or `PlayCanvas app found via …`, then `live on canvas…`.
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
node deps.mjs                    # three@0.180.0 + playcanvas@2.22.3 + @sparkjsdev/spark@2.2.0 into .deps/ (npm pack; local overrides below)
node run.mjs                     # every case; `node run.mjs a a-legacy` for one; KEEP=1 writes out/<case>.png
```

**Engines, and a box with no registry access.** `deps.mjs` fails loudly (non-zero exit, the file
and the override to use) instead of leaving a page that never converts, and `run.mjs` checks the
same seven files and the Chrome binary before it starts (exit 2), and fails a case at once, naming
the file, if a page gets a 404 for anything under `/deps/`. Every file can come from a local copy:
`THREE_BUILD_DIR` (`three.module.js` + `three.core.js`), `PLAYCANVAS_MJS`, and for the addons
`THREE_ORBIT_CONTROLS` / `PLAYCANVAS_CAMERA_CONTROLS`, or found next to the first two when they point
into an npm package layout (`<THREE_BUILD_DIR>/../examples/jsm/controls/OrbitControls.js`,
`<PLAYCANVAS_MJS>/../../scripts/esm/camera-controls.mjs`). The Spark page also needs
`SPARK_DIST` (a dir holding `spark.module.js`; default `npm pack @sparkjsdev/spark@2.2.0`) and
three's `postprocessing/Pass.js` (`THREE_PASS_JS`, or next to `THREE_BUILD_DIR` in an npm layout).
With all of them set, nothing is fetched.

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
| `m-lift-live-three` / `m-lift-live-pc` | the lift attribute added while live | back to 2D in < 3 s through the staged path (out-cover, `mono frame drawn first`), no raw pair at close (commit model), marker removed after the close, no retry 3 s later |

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

On Windows the harness uses the installed Chrome (`CHROME=` to override) with ANGLE D3D11. Chrome
is launched with `--disable-features=OpenXR,WebXR`: the fake provides `navigator.xr`, and PlayCanvas's
`xrCompatible` context otherwise makes Chrome load the box's REAL OpenXR runtime, which on a box
with DisplayXR installed can block context creation (every PlayCanvas page then times out on load).

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

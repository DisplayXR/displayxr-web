# DisplayXR inline-3D SDK (`js/`)

A dependency-free helper over the `inline-3d` WebXR surface. One call turns a `<canvas>` into a
glasses-free-3D window; everything degrades to plain 2D on a non-DisplayXR browser.

## `inline3d.js`

```js
import { createInline3D, inline3DAvailable } from './inline3d.js';
```

**`inline3DAvailable() → boolean`** — cheap synchronous "could this browser attempt inline-3D?"
gate (DisplayXR Browser with the feature on). Use it to decide page UI up front. It does **not** call
`navigator.xr.isSessionSupported()` (that async probe false-negatives before the weave service binds).

**`await createInline3D(opts?) → Inline3D | { supported: false }`** — opens the page's inline-3d
session and returns a manager (the "wall"). Check `.supported`:

```js
const wall = await createInline3D();     // opts: { referenceSpace='viewer', lazy=true, rootMargin,
                                         //         autoChrome=true, modeSwitch }
if (!wall.supported) { /* normal 2D page */ return; }
```

`opts.lazy` (default `true`) creates each window's weave layer only while it's near the viewport and
closes it when it scrolls away — so a long wall only pays for what's on screen.

### Wall methods (one call per element)

- **`wall.addImage(canvas, source, opts?)`** — a still side-by-side (SBS) 3D photo. `source` is a
  URL or image; `opts`: `{ width, height, cornerRadius }`.
- **`wall.addVideo(canvas, video, opts?)`** — an SBS 3D video; redraws the `<video>` each frame.
- **`wall.addScene(canvas, onFrame, opts?)`** — a live-rendered stereo scene. `onFrame(views, layer)`
  runs each XR frame; render your two eye views into the canvas as an SBS pair. `opts.virtualDisplayHeight`
  (default 0.24 m) sets the scene scale. **Validate `views` before you clear** — under load the frame
  can report fewer than two views, and clearing on such a frame is what a "blinking" tile is
  ([authoring guide](../docs/authoring-inline-3d.md#3-live-scene-threejs--webgl--addscenecanvas-onframe-opts)).
- **`handle.setViewRig(rig)`** — replace the **view rig** the runtime locates this window's views
  against: a posed **display** rig (the canvas as a portal onto a virtual display) or a **camera**
  rig (the app's own camera, whose frustum eye tracking perturbs). Cheap enough to call every
  frame — a rig applies per-locate, so animating one is just sending new values. `addScene`'s
  `opts.viewRig` sets the first one. Returns `false` on a browser without `setViewRig` (warns once;
  the window still weaves). Gate with **`inline3dViewRigSupported()`**.
  [Full section](../docs/authoring-inline-3d.md#view-rigs-display-vs-camera) — including the
  one-frame latency caveat and the **attach** pattern that removes it.
- **`handle.stats()`** — `{ frames, monoFrames }` for a scene window; `monoFrames` counts the
  frames that arrived with fewer than two views.
- **`wall.close()`** — end the session and release all windows.

### Display modes (on the wall *and* on every handle)

The panel is the document's, not a tile's — one display, one active rendering mode — so these
live on the `createInline3D()` result. The same names are on each tile handle too, routed to
whichever window currently holds a live layer. Gate the group with
**`inline3dDisplayModesSupported()`**; example: [`../samples/display-modes/`](../samples/display-modes/).

- **`getDisplayInfo()` / `getRenderingModes()`** — what the panel *is* (physical size, pixel size,
  the per-view scale it recommends; `null` where there is no glasses-free display) and every
  rendering mode the runtime can put it in. Both promise-returning. The mode list is the
  **display's**, not the browser's: the browser renders exactly two views, so a mode with
  `viewCount > 2` is reported `isRequestable:false`. All the scale fields are **advisory** — the
  browser cannot resize your canvas, so a page honours them by sizing its own backing store.
- **`requestRenderingMode(i)`** — switch the display to mode `i`. A thin pass-through: rejects
  `TypeError` for a `viewCount > 2` mode or an unknown index (the browser raises that one
  synchronously; the SDK hands it back as a rejection so one `.catch()` covers everything) and
  `NotSupportedError` when the request was not forwardable.
- **`setStereoEnabled(bool)`** — **sugar only.** `false` requests the first mode with
  `viewCount === 1 && isRequestable`, `true` the first with `viewCount === 2 && isRequestable`.
  It never touches the hardware display state directly (there is no such call) and never touches
  your rig.
- **`on(type, cb)` / `off(type, cb)`** — the two session events re-emitted on the handle:
  `renderingmodechange` `{type, modeIndex, viewCount, mode, detail}` and
  `hardwaredisplaystatechange` `{type, state:'2d'|'3d', detail}`. `on` returns an unsubscribe.
  **`onDisplayModeChange(cb)`** is the older both-events-one-callback shape and still works.
- **`wall.hardwareDisplayState`** (`'2d'|'3d'|null`), **`wall.activeMode`**
  (`{modeIndex, viewCount}`) and **`wall.stereoCollapsed`** — read-only, and always what was last
  **reported**, never what was last requested. **`wall.modeSwitch`** (`{active, factor}`) is the
  live state of the eased transition below.

#### The eased 2D↔3D transition (`opts.modeSwitch`)

On by default, and the same sequencer — with the same defaults, **180 ms** / **smoothstep**
(Hermite `3t^2 - 2t^3`) — that the native DisplayXR apps use. A **page-initiated** switch no longer
snaps the stereo rig: every window's `ipdFactor`/`parallaxFactor` ramps between 0 and what the page
asked for, in the order that looks right.

```js
const wall = await createInline3D({ modeSwitch: { durationMs: 180, easing: 'smoothstep' } });
await wall.setStereoEnabled(false);   // resolves once the request has been FORWARDED (post-ramp)
wall.modeSwitch;                      // { active: boolean, factor: 0..1 }  read-only
```

- **Going flat** (a `viewCount === 1` target) ramps the disparity **out first** and forwards the
  mode request only when it lands, so the panel flips on already-flat content. That is the one
  timing change: `requestRenderingMode(i)` / `setStereoEnabled(false)` resolve when the request
  reaches the browser, about `durationMs` later, and still reject exactly as before if it fails —
  a refused switch ramps back **up**, because a refusal must leave you in 3D, not flat.
- **Coming back** (a 2-view target) forwards the request **immediately** and eases the disparity in
  only once the panel **reports** 3D. Ramping up before that would put stereo on a still-flat
  panel, which is the double image the whole mode API exists to prevent.
- **Interruptible.** Pressing the toggle again mid-ramp retargets from the disparity in force (no
  snap, ever — including the first press). Reversing a going-flat switch that has not fired yet
  just ramps back up and **never** asks the panel for anything; the dropped request rejects with an
  `Error` named `superseded`.
- A mode change the page did **not** request — another tab, the shell, a page that opens with the
  panel already flat — still **snaps**, because there is nothing to ramp from.
- `{ enabled: false }` restores the plain 1.4.0 snap. `{ durationMs: 0 }` keeps the ordering but
  lands in one frame.

It is **aesthetic policy only**: correctness (the eye-set coherence around a switch) is the
runtime's job either way, and the SDK adds **no UI** — which key or button toggles the display is
the page's call.

**The 2D/3D hardware state is a consequence of the mode, not a control.** Requesting a one-view
mode puts the panel in its 2D state and the runtime carries on weaving the same two-view atlas;
requesting the two-view mode puts it back. So the SDK **collapses the stereo rig automatically**
when a 1-view mode goes active — every window's `ipdFactor`/`parallaxFactor` to 0, so both eyes
render from one place — and restores it when a 2-view mode does. That is driven by the
`renderingmodechange` event (and by the first `getRenderingModes()` read, for a page that opens
with the panel already flat), **not** by the request: your rendering is unchanged, it happens
however the mode changed, and a **refused** request changes nothing in either direction. The
flattening is a *copy* pushed at the layer, never a write into your descriptor, so the restore is
exactly the rig you last set — and it holds through a per-frame `setViewRig` loop and a lazy tile
rebuilding its layer.

### Undock

Lift a window's asset out of the page into a floating, transparent native viewer over the desktop.

- **`wall.undock`** — `{model:boolean, splat:boolean}` on a browser with `XRDisplayLayer.undock`,
  and **`null`** on one without (plain Chrome, or an older DisplayXR browser) — that null is what
  a page branches on. The values are read off the first live layer via
  `layer.getUndockCapabilities()`; **`wall.refreshUndock()`** re-reads them.
  **`inline3dUndockSupported()`** is the sync probe.
- **`await undock(element, opts)`** (from `inline3d.js` or `inline3d-undock.js`) —
  `opts = {src, type:'model'|'splat', env?, pose?, margin?, title?}`. `src` must be absolute
  https, or http on loopback. **Call it synchronously inside the click** — both paths need the
  transient activation. Resolves once the viewer has LAUNCHED (the API path resolves as soon as
  the viewer process is spawned and never waits for it) to `{ended: Promise<void>, viewer,
  detached}`; `ended` resolves when the viewer exits, which the API path hears as the
  XRSession's `undockend` event. Rejects with an Error named `not-installed` |
  `src-not-allowed` | `no-activation` | `busy` (the browser's DOMException names are mapped).
- Where the layer API is absent it falls back to the `displayxr-view:` OS protocol (a hidden-iframe
  navigation, Chrome's one-time "Open DisplayXR…?" prompt). That path is fire-and-forget:
  `ended` resolves immediately and `detached === true`. `undockUrl(el, opts)` and
  `tileScreenRect(el)` are exported for logging/tests; `undockAvailable()` reports the platform
  (the viewers are Windows-only).

**`await startInline3D(canvas, { onFrame, referenceSpace?, virtualDisplayHeight? })`** — back-compat
single-scene helper: `createInline3D({lazy:false})` + `addScene`. Returns `{ supported, close(), wall }`.

## Vendoring

`inline3d.js` statically imports `inline3d-undock.js` and (since 1.5.0) `inline3d-mode-switch.js`;
copy all three together (plus `inline3d-three.js` if you use the three.js helpers). The npm package
and the jsDelivr commit URLs already carry the set.

## `inline3d-three.js`

Optional three.js glue. **`EyeCamera`** builds an off-axis (asymmetric-frustum) camera from an
`addScene` view each frame — the two load-bearing renderer settings are documented at the top of the
file. `setFromView` sets the camera's WORLD pose; `setLocalFromView` sets its LOCAL one so it can be
parented under your app camera (the attach pattern). **`cameraRigFromCamera(THREE, camera, opts)`**
and **`displayRig(opts)`** build the descriptors `setViewRig` takes, both accepting an `out` object
so a per-frame call allocates nothing. **`EdgeFeather`** fades a rendered eye's edges to
transparent. Examples: [`../samples/camera-rig/`](../samples/camera-rig/) (rigs),
[`../samples/windows/`](../samples/windows/).

## SBS buffer convention

A woven window's canvas holds a **double-width** side-by-side pair (left eye | right eye) that the
browser interlaces on the panel. `addImage`/`addVideo` maintain the buffer for you; `addScene` hands
you the two eye views and you draw the pair yourself.

Full authoring guide: [`../docs/authoring-inline-3d.md`](../docs/authoring-inline-3d.md).

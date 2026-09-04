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
const wall = await createInline3D();     // opts: { referenceSpace='viewer', lazy=true, rootMargin }
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

**`await startInline3D(canvas, { onFrame, referenceSpace?, virtualDisplayHeight? })`** — back-compat
single-scene helper: `createInline3D({lazy:false})` + `addScene`. Returns `{ supported, close(), wall }`.

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

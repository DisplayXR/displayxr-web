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
  (default 0.24 m) sets the scene scale.
- **`wall.close()`** — end the session and release all windows.

**`await startInline3D(canvas, { onFrame, referenceSpace?, virtualDisplayHeight? })`** — back-compat
single-scene helper: `createInline3D({lazy:false})` + `addScene`. Returns `{ supported, close(), wall }`.

## `inline3d-three.js`

Optional three.js glue. **`EyeCamera`** builds an off-axis (asymmetric-frustum) camera from an
`addScene` view each frame — the two load-bearing renderer settings are documented at the top of the
file. Example: see [`../samples/windows/`](../samples/windows/).

## SBS buffer convention

A woven window's canvas holds a **double-width** side-by-side pair (left eye | right eye) that the
browser interlaces on the panel. `addImage`/`addVideo` maintain the buffer for you; `addScene` hands
you the two eye views and you draw the pair yourself.

Full authoring guide: [`../docs/authoring-inline-3d.md`](../docs/authoring-inline-3d.md).

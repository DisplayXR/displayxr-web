# Authoring inline-3D pages

Inline-3D lets a web page show **glasses-free 3D elements** — 3D photos, 3D videos, live 3D
scenes — inside otherwise ordinary HTML, on a DisplayXR display. Each 3D element is a
`<canvas>` the browser's compositor **weaves** to the display's lenticular optics; the rest
of the page stays flat 2D. On any other browser the same page shows plain 2D content, so
inline-3D is progressive enhancement, never a hard dependency.

This page is the authoring reference. The `js/inline3d.js` SDK implements everything here;
you rarely need the raw WebXR interfaces, but they're documented at the end.

## The one contract you must understand

**A weaved window is a `<canvas>` whose backing buffer holds side-by-side (SBS) stereo — the
left eye in the left half, the right eye in the right half — while its on-screen CSS box is
whatever shape the viewer should see.** The weave un-squishes the two halves back onto the
box.

- A **square** 3D photo → a **2:1** backing buffer (e.g. `1024×512`) in a **square** CSS box.
- A **16:9** 3D movie → a **32:9** backing buffer in a **16:9** box.

If you size the canvas buffer 1:1 with the box you get a squished result and **no error** —
this is the single most common mistake. The SDK's `addImage`/`addVideo` own the buffer for
you (you just style the box); for `addScene` you render into the two eye viewports the SDK
hands you.

## Quick start — one 3D photo

```html
<canvas id="pic" style="width:240px; height:240px"></canvas>
<script type="module">
  import { createInline3D } from './js/inline3d.js';
  const wall = await createInline3D({ lazy: false });
  if (wall.supported) {
    wall.addImage(document.getElementById('pic'), 'photos/cat_sbs.jpg');
  }
  // else: the <canvas> stays blank on non-DisplayXR browsers — put a 2D <img> fallback
  // behind it, or draw the left half yourself.
</script>
```

`cat_sbs.jpg` is a normal side-by-side stereo image (left view | right view). That's it —
no per-eye code, no WebXR boilerplate.

## The three content types

Everything a window can show is "fill a canvas with SBS pixels." The SDK has one entry point
per source:

### 1. Still 3D photo — `addImage(canvas, source, opts?)`

`source` is a URL, `HTMLImageElement`, `ImageBitmap`, or `<canvas>` holding full SBS content.
Painted once. Optional `{ width, height }` set the per-eye buffer resolution (default: the
CSS box × devicePixelRatio); `{ cornerRadius }` bakes rounded corners **per eye** (see
[Rounded corners](#rounded-corners)).

### 2. 3D video / movie — `addVideo(canvas, videoEl, opts?)`

`videoEl` is a playing `<video>` whose frames are full SBS 3D (left | right). The SDK
redraws the current video frame into the SBS buffer every frame while the window is visible.
Same `opts` as `addImage`.

```js
const v = document.querySelector('video#movie');   // a normal SBS 3D .mp4, muted+loop+play()
wall.addVideo(document.getElementById('screen'), v);
```

A 2D movie is not 3D — the source must be stereo (a full-width SBS encode). Top-bottom
encodes aren't supported; re-pack to SBS first.

### 3. Live scene (three.js / WebGL) — `addScene(canvas, onFrame, opts?)`

You own the canvas and its context; the SDK creates the weave layer and calls `onFrame(views,
layer, frame)` each frame with the two eye `XRView`s. Render each into
`layer.getViewport(view)` — an `{x, y, width, height}` sub-rect of the canvas — using the
view's `projectionMatrix` and `transform.matrix`.

For three.js, `js/inline3d-three.js` provides an `EyeCamera` that removes the matrix plumbing.
Minimal loop:

```js
import * as THREE from 'three';
import { createInline3D } from './js/inline3d.js';
import { EyeCamera } from './js/inline3d-three.js';

const eye = new EyeCamera(THREE);
wall.addScene(canvas, (views, layer) => {   // addScene sets virtualDisplayHeight = 0.24 m
  renderer.clear();
  renderer.setScissorTest(true);
  for (const view of views) {
    const vp = layer.getViewport(view);
    renderer.setViewport(vp.x, vp.y, vp.width, vp.height);
    renderer.setScissor(vp.x, vp.y, vp.width, vp.height);
    eye.setFromView(view);             // projection + pose straight from the view
    renderer.render(scene, eye.camera); // author in metres; NO per-frame scaling
  }
  renderer.setScissorTest(false);
});
```

**Scene scale is the runtime's job — don't do it in your app.** The session's views are in
**display-local metres**: the canvas plane is world `z = 0` (the zero-disparity / in-focus
plane) and the eye sits a few tens of cm in front. Author your scene in metres for a **virtual
display height** — `0.24 m` by default (`addScene`'s `virtualDisplayHeight` option; the same
`m2v` knob the native `XR_DXR_view_rig` extension exposes) — put focused content at `z = 0`
(`+z` behind the glass, `−z` in front), and **render the views directly**. The runtime scales
each eye pose by `virtualDisplayHeight / element_physical_height`, so the `z = 0` plane spans
that virtual display and the scene renders at its authored scale with **no per-frame world
scaling**. A bigger `virtualDisplayHeight` shows a larger slice of the world in the element.
This mirrors the native reference apps (`cube_handle`): the app supplies one scale number and
consumes render-ready views — it never re-derives the projection or scales the scene.

## Many windows, and how batching helps

Add as many windows as you like to one `wall` — a gallery, a grid, a scrolling wall. The
DisplayXR runtime **batches every visible window into one weave call per frame**, so N
windows cost roughly the same as one; you write nothing batch-specific. The only lever you
have over cost is *how many windows are live at once*, which the SDK manages for you:

- **`lazy: true` (default)** — each window's weave layer is created only while it's
  (near-)visible and closed when it scrolls away, so a 500-photo wall only pays for the
  ~dozen on screen. `rootMargin` (default `'50% 0px'`) pre-arms windows half a viewport early
  so a fast scroll never flashes a raw frame.
- **`lazy: false`** — for a page with one always-on 3D element (like a hero cube). All
  windows stay woven.

```js
const wall = await createInline3D();          // lazy defaults on
if (wall.supported) {
  for (const tile of tiles) wall.addImage(tile.canvas, tile.url);
}
```

Call `handle.remove()` (returned by each `add*`) to drop one window, or `wall.close()` to
end the session and release everything.

## Detecting support — do this, not that

Use **`createInline3D()`** (or `inline3DAvailable()` for a synchronous pre-gate). If it
returns `{ supported:false }`, render your 2D fallback.

**Do not** gate on `navigator.xr.isSessionSupported('inline-3d')`. It's an async round-trip
to the OS weave service that resolves **false** if it runs before the service has bound —
typically at page load — silently dropping a capable browser to 2D. `createInline3D` uses the
Blink-local `requestSession` path, which resolves correctly and immediately.

```js
import { inline3DAvailable } from './js/inline3d.js';
if (!inline3DAvailable()) showFlat2D();        // cheap, synchronous, no false-negative
```

## Rounded corners

CSS `border-radius` on a weaved canvas rounds the **packed SBS rectangle's** outer corners —
so after the eye-split the left view is rounded only on its left and the right only on its
right (lopsided). Round **per eye, in buffer pixels** instead: pass `{ cornerRadius }` to
`addImage`/`addVideo` (the SDK bakes it), or for scenes clip each viewport yourself. The same
applies to any decoration: a border/background drawn in CSS is woven with the element and its
silhouette only rounds the packed rect — keep the stage visually bare and bake decoration
into the canvas.

## Gotchas checklist

- **Buffer is 2:1 (or 2× the box's aspect), not 1:1.** `addImage`/`addVideo` handle it; only
  a concern if you build buffers by hand.
- **Detect with `createInline3D`, never `isSessionSupported`.**
- **Round corners / draw decoration in the canvas buffer, not CSS.**
- **Scenes: author at ~0.24 m virtual height and `fitToElement` every frame;** put focused
  content at `z=0`.
- **Compositor layer:** the SDK sets `will-change:transform; transform:translateZ(0)` on
  managed canvases so each is a distinct weave target — keep it if you build windows manually.
- **The page still works in 2D.** Always ship a fallback for `{ supported:false }`.

## Under the hood (raw WebXR)

The SDK is thin; if you want the primitives:

- `navigator.xr.requestSession('inline-3d')` → a sensorless inline session. `RuntimeEnabled`
  by `DisplayXRInline3D`; only present in the DisplayXR Browser with inline-3D enabled.
- `session.requestReferenceSpace('viewer')`, then `session.requestAnimationFrame(cb)`; in the
  callback `frame.getViewerPose(refSpace).views` yields two `XRView`s, each with a
  `projectionMatrix` (off-axis frustum) and `transform.matrix` (eye world pose) updated to
  your tracked eyes every frame — the look-around.
- `new XRDisplayLayer(session, canvas)` binds a canvas — **constructing the layer is the
  activation** (there is no `updateRenderState({layers})` step). The layer reports the
  canvas's live rect to the compositor each frame and exposes `getViewport(view)` (the SBS
  left/right split) and `close()`.

That's the whole surface. Everything else on this page is convention the SDK encodes for you.

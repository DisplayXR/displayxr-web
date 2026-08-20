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

**Validate before you clear — the frame you get is not guaranteed to be stereo.** The loop above
is the shape of the thing; a production one has a gate in front of it. `renderer.clear()` is the
point of no return: after it the canvas is transparent-black, and if the frame then fails to draw
both eyes over it, *that empty buffer is what the weave consumes* — one dark tile. Under GPU load
the session can hand your callback a **short view list** (one view, or none: a per-frame mono
fallback), and `layer.getViewport(view)` can come back `null`. Neither throws; both produce a
black blink you will read as a weave bug (web#12).

So check everything **before** touching the canvas — `views.length >= 2`, a viewport for every
eye — and when a frame can't draw, **repaint the last good one rather than skipping the frame**.
Skipping is not safe: the weave reads each window's composited canvas every frame, and a canvas
that isn't redrawn can drop out of the aggregated frame, leaving a stale sub-rect that smears. A
one-frame-stale eye pose is imperceptible; a black frame and a smear are not. Keep a **copy** of
the last good `projectionMatrix` / `transform.matrix` per eye to replay from — never the `XRView`
itself, which is only valid inside the callback that delivered it — and feed the copies back with
`EyeCamera.setFromMatrices(proj, transform)`.

`./viewer` (and so `./splat` and `./model`) does all of this for you; use it unless you have your
own loop. `handle.stats()` reports `{ frames, monoFrames }` per scene window if you want to see
how often the fallback is firing on real hardware.

**Resizing clears the buffer, even when nothing changed.** Writing `canvas.width` or
`canvas.height` reallocates the drawing buffer — including a write of the *same* value, which is
what `renderer.setSize()` does unconditionally. A `ResizeObserver` fires on plenty of things that
leave the buffer's dimensions exactly where they were, and its callback runs *after* rAF and
*before* paint, so a no-op resize commits one black frame with nothing on the way to repaint it.
Compare the computed size against `renderer.domElement.width/height` first, and when it genuinely
changed, re-render **immediately** rather than waiting for the next frame.

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

**Navigation and resize are handled for you.** A window's rect reaches the compositor from the
session's own animation frames, so a page that stops running frames leaves its last rects
weaving — which is what a back-navigation into the bfcache used to do (ghost 3D windows on the
next page, browser#87). The SDK releases every live window on `pagehide`/`freeze` and re-arms
them on `pageshow`/`resume` through the same lazy logic, so you neither see the ghosts nor have
to wire anything. Likewise a live window whose CSS box or `devicePixelRatio` changes — a
responsive reflow, a browser zoom, a drag to a different-scale monitor — has its SBS buffer
re-derived and repainted; that's for `addImage`/`addVideo` windows, whose buffer the SDK owns.
An `addScene` canvas is yours: resize its buffer yourself, keeping the 2× width.

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

## 2D over 3D — draw-order occlusion

**Where the browser occludes by draw order, 2D over a woven window just works.** The compositor
composites any 2D content over the woven tiles **per-pixel, by draw order** — exactly like
stacking 2D over 2D. There is nothing to declare: no data-attribute, no `exclude()` call, no
registration of your header.

This is the browser's **Phase-2 compositor path** (a plane split in viz, replacing the Phase-1
geometric matcher). It is not the default yet — see [Rollout](#rollout) at the end of this
section for exactly what is live when, and why the SDK's answer is `false` until it is.

That means all of this is ordinary HTML/CSS again, with no inline-3D wiring at all:

- a sticky **header**, a floating **toolbar**, a bottom bar — tiles scroll under them as flat 2D;
- a **badge**, a play button, a like animation, a caption plate on a tile;
- a **dropdown**, a menu, a tooltip, a modal that opens across several tiles;
- a **translucent scrim** — where it is transparent you see the woven 3D through it, where it is
  opaque you see crisp 2D, and a gradient blends between the two;
- an overlay that covers a **whole** tile (the old "partial region only" rule is a legacy-path
  constraint; see below).

Draw order is the CSS stacking order you already reason about: paint over a tile and you occlude
it. Nothing about the tile changes — its buffer is still side-by-side stereo
([the one contract](#the-one-contract-you-must-understand)), it is still lazily woven, it still
scrolls.

**The case that still does not work is `backdrop-filter`** on anything that overlaps a tile.
A backdrop filter is by definition a function of *what is behind it*, and behind it is the
woven, lens-interleaved buffer — not the flat image it would need to blur. Drop the blur and use
a near-solid background (`rgba(16,17,22,.92)` reads much like a frosted bar), or keep the blur on
a surface that never overlaps a tile. Same guidance as before, and the piece of it that survives.

More precisely — and this is the whole of the small print — the first version of the split is
**conservative about content that does not draw as a plain quad**. Anything that reaches the
compositor through its own render pass, or out of the normal painting order, is left where it is
rather than lifted over the weave, and so weaves like Phase-1 content did:

- pixel-moving filters — `filter: blur()`, `drop-shadow()` — and `backdrop-filter`;
- blend modes other than normal (`mix-blend-mode`, `background-blend-mode`);
- 3D sorting contexts (`transform-style: preserve-3d` and friends).

None of that is a limitation you feel on ordinary chrome: a header, a badge, a menu, a scrim, a
plate with a solid or translucent background and text are all plain quads. Keep effects off
whatever overlaps a tile — the same rule as before, with a shorter list.

### Asking which mechanism you are on

```js
import { inline3dOcclusionByDrawOrder } from '@displayxr/inline3d';
if (inline3dOcclusionByDrawOrder()) {
  // automatic: your 2D already occludes the tiles, and the SDK's exclusion machinery is off
}
```

`inline3dOcclusionByDrawOrder()` reads a **readonly capability flag** on `XRDisplayLayer` —
never a version or user-agent string, which would rot the moment a page is pinned to an SDK for
a year. It is `false` on any browser that does not expose the flag, and false is the *safe*
answer: the SDK then runs the legacy exclusion machinery below, which is what such a browser
needs.

Note the flag is the **only** sound probe. `XRDisplayLayer.excludeElement` is untouched on a
draw-order browser — the Phase-2 change is in the compositor, not the JS API, so the method is
still there, still accepts your element, and simply has no effect on the new draw — so its
presence says nothing about which mechanism is live, and
`inline3dOverlaySupported()` (which asks the older question, "does 2D on a tile composite as
crisp 2D?") is true on both.

**You do not have to branch on it.** The legacy calls are harmless where occlusion is automatic
(the SDK accepts and ignores them, and one `console.info` says so), and still required where it
is not. Branch only to drop work of your own: a `data-inline3d-overlay` attribute you would
otherwise maintain, a full-tile plate the legacy path has to refuse, or a near-solid background
you only keep because a translucent bar used to be risky.

### Rollout

Written for the transition, and safe at every step of it:

| Browser state | `inline3dOcclusionByDrawOrder()` | What the SDK does |
|---|---|---|
| No Phase-2 path (everything published so far) | `false` | Legacy exclusion machinery, unchanged |
| Phase-2 present but off (its default today) | `false` | Legacy machinery — correct, because that *is* the live path |
| Phase-2 on, capability flag not yet exposed | `false` | Legacy machinery: redundant but harmless (see below) |
| Phase-2 on, flag exposed | `true` | Nothing — no scan, no observers, no promotions |

The third row is the one to understand: the browser's occlusion switch is enabled but the page
cannot see it, so the SDK keeps declaring exclusions. That is **harmless** — the declarations are
collected browser-side and have no effect on the Phase-2 draw, and the tiles are occluded
correctly either way — the page merely pays the SDK's chrome scan and its `will-change`
promotions for nothing. Exposing the flag (one readonly attribute) is what closes that row, and
it is deliberately the browser's call to make: this SDK cannot infer the switch, and will not
guess from a version.

**Do not try to get ahead of it.** In particular, do not test
`XRDisplayLayer.prototype.occlusionByDrawOrder` yourself — reading an IDL attribute getter with
the prototype as receiver throws `TypeError: Illegal invocation`, so the obvious hand-rolled
probe breaks on exactly the browser it is looking for. Call the SDK helper.

## 2D overlays ON a 3D window — overlay exclusion (legacy browsers)

> **Legacy-browser mechanism.** Everything in this section and the next applies to DisplayXR
> Browsers *without* draw-order occlusion. On a browser that has it, the section above is the
> whole story and the APIs below are accepted-and-ignored — keep them in a page that also ships
> to older browsers, delete them if you don't.

An Instagram-style hover plate, a play badge, a like animation — 2D DOM positioned **over**
a weaved window — would by default be woven along with the content and come out interleaved.
Overlay exclusion (browser#18) fixes this: the browser grabs the overlay as its own isolated
layer and composites it **over** the woven 3D — `final = plate + (1−plate.a)·woven`, true
2D-over-3D. It also feeds the weave the canvas's clean pixels (without the overlay), so the 3D
**under** a translucent overlay is clean woven 3D, not a woven copy of the plate. Result: an
opaque plate is crisp, a gradient scrim reveals the 3D through its transparent part, exactly as
you'd expect from stacking 2D over 3D. (2D-*under* is reserved for a future release.)

Two ways to use it:

```html
<!-- Declarative (preferred): mark the overlay; the SDK auto-excludes marked
     descendants of the canvas's container while the window is woven. -->
<div class="stage">
  <canvas class="pic"></canvas>
  <div class="plate" data-inline3d-overlay>Golden Gate · f/8 · 1/500s</div>
</div>
```

```js
// Imperative: the handle returned by addImage/addVideo/addScene.
const win = wall.addImage(canvas, url);
win.exclude(plateEl);     // and win.unexclude(plateEl) to undo
```

Rules of the road:

- **Hide with `display:none`, not `opacity`/`visibility`.** Only `display:none` reports an
  empty rect; an `opacity:0` plate is still "there" and keeps compositing over the weave. Mark
  the plate once, toggle `display` on hover.
- **Translucent plates reveal the 3D underneath, cleanly.** Where the plate is transparent the
  woven 3D shows; where opaque the plate is crisp; a gradient scrim blends — no artifact under
  the scrim (the weave never sees the plate). The SDK promotes the overlay onto its own
  compositing layer for you with `will-change: transform`; if you call `layer.excludeElement`
  by hand, set `will-change: transform` on the element yourself, or it will weave instead of
  compositing over. (A CSS `filter` does **not** work here — its render surface is flattened
  away in the weave path; `will-change: transform` is the reliable promotion.)
- **An overlay must be a PARTIAL region of the tile — never the whole tile.** The browser
  re-composites an excluded element by *geometrically matching* its rect to a composited-layer
  quad (≥70% area overlap). A plate that covers the whole canvas matches the **canvas's own**
  quad, so the canvas is staged as the overlay: it leaves the weave input and the tile presents
  its raw side-by-side buffer — two squished halves, no 3D. A caption band, a badge, a corner
  plate, a bottom scrim are all fine; a full-bleed hover layer over the picture is not. Cover
  the tile with a **partial** plate plus a background on the plate, or put the element outside
  the tile as page chrome (below). The SDK measures this and refuses a full-tile exclusion with
  a console warning rather than destroying the tile — but it can only judge the rect it can
  measure, so a plate that is `display:none` at registration and becomes full-tile when shown
  slips through. The rule is yours to keep.
- **A `backdrop-filter` element can never be an overlay.** Exclusion needs the element as an
  isolated composited resource — the element rastered on transparency. `backdrop-filter` is
  defined as a function *of what is behind it*, so it has no such resource: the browser has
  nothing to hand the compositor, and the element either weaves anyway or drops out. There is
  no flag for this. On the woven path, drop the blur and use a near-solid background
  (`rgba(16,17,22,.92)` reads much like a frosted bar) — and if you want the blur off the
  woven path, keep it on a surface that never overlaps a tile.
- **Older DisplayXR Browsers** (no `excludeElement`): silent no-op — the overlay weaves like
  before. Progressive enhancement, nothing to detect (the SDK feature-detects internally).
- **Newer DisplayXR Browsers** (draw-order occlusion): also a no-op, for the opposite reason —
  the overlay already composites over the woven 3D, and none of the rules above apply to it (a
  full-tile plate is fine, a translucent one is fine, no promotion is needed). `backdrop-filter`
  remains the exception.

## Page chrome — headers, toolbars, floating bars (legacy browsers)

*(Legacy-browser mechanism — where the browser occludes by draw order, chrome needs no
registration at all and this whole section is inert. See
[draw-order occlusion](#2d-over-3d--draw-order-occlusion).)*

The overlays above live *inside* a tile's container. Page **chrome** is the other case: a
sticky header, a floating toolbar, a bottom bar — furniture that sits outside every tile and
overlaps *many* of them as they scroll under it. Excluding it per tile would race the lazy
lifecycle (a tile that re-activates has a fresh layer and a fresh, empty exclusion set), so
chrome is registered **page-globally** instead: excluded from every window, current and future,
and re-applied automatically on every re-activate.

**By default the SDK finds it for you.** `createInline3D({ autoChrome: true })` — the default —
scans for page chrome at session start and again as tiles activate:

- **Shallow scan:** the top **three DOM levels** under `<body>`, keeping elements whose
  computed `position` is `fixed` or `sticky`. Page chrome lives there; a sticky element deeper
  in the tree (a table header inside a scroller) is *content*, not chrome, and is left alone.
- **Per-element text plates:** besides the bar itself, its text-bearing and replaced
  descendants (`img`, `svg`, `video`, `canvas`, form controls) are registered individually. A
  full-width bar can raster as several compositor tile quads, each a fraction of the bar's
  rect — so none of them matches the bar's rect and the bar never stages. The small per-text
  plates each promote to their own layer and match ~1:1, which is what closes the visible
  failure (a near-solid bar hides everything *except* its text, because a uniform colour weaves
  to itself).
- **Throttled to once a second:** layer activations burst during a scroll, and each one is a
  rescan point, so late-mounted chrome is picked up without rescanning per tile.
- **Opt out** with `data-inline3d-no-overlay` on an element — it and its whole subtree are
  skipped. An element that *contains* a woven window is never plated (that would hand the
  weave input back to the compositor as crisp 2D).

Its limits, all consequences of "shallow, throttled, computed-position": chrome deeper than
three levels, chrome that is neither `fixed` nor `sticky` (a `position:absolute` bar in a
scroll container), and chrome that mounts and then *moves* within the same second are not
covered. Register those yourself:

```js
const wall = await createInline3D();                       // autoChrome on by default
wall.addGlobalOverlay(document.querySelector('.deep .toolbar'));
// …and to stop:
wall.removeGlobalOverlay(el);
```

`addGlobalOverlay(el)` is also the right call whenever you want chrome handled *explicitly* —
pass `autoChrome: false` and register every bar by hand if you'd rather the SDK never touch
your DOM's `will-change`. Both paths are no-ops on a browser without overlay exclusion.

Two things to know about chrome specifically:

- **Keep `backdrop-filter` off it.** A blurred sticky header is the single most common chrome
  mistake: it cannot be excluded at all (see the rule above), so tiles weave straight through
  it. Use a near-solid background instead.
- **Seams during scroll.** Exclusion keeps chrome out of each tile's weave input, but the
  per-tile present can still seam a page-global bar where it spans the gap between two tiles.
  The systematic fix is the whole-window composited present (browser#22).

## Gotchas checklist

- **Buffer is 2:1 (or 2× the box's aspect), not 1:1.** `addImage`/`addVideo` handle it; only
  a concern if you build buffers by hand.
- **Detect with `createInline3D`, never `isSessionSupported`.**
- **Round corners / draw decoration in the canvas buffer, not CSS.**
- **Scenes: author at ~0.24 m virtual height and `fitToElement` every frame;** put focused
  content at `z=0`.
- **Compositor layer:** the SDK sets `will-change:transform; transform:translateZ(0)` on
  managed canvases so each is a distinct weave target — keep it if you build windows manually.
- **2D over a tile just works** on a browser with draw-order occlusion — headers, badges,
  dropdowns, translucent scrims, nothing declared. The next two items are *legacy-browser*
  rules; ask `inline3dOcclusionByDrawOrder()` which world you are in, and keep the legacy calls
  if you ship to both (they're accepted and ignored where they're unnecessary).
- **Legacy: overlays are partial regions of a tile, never the whole tile.** A full-tile plate
  matches the canvas's own quad and the tile falls out of the weave.
- **Legacy: page chrome is page-global, not per-tile.** `autoChrome` covers sticky/fixed
  furniture in the top three DOM levels; anything else goes through `addGlobalOverlay()`.
- **No effects on anything that overlaps a tile.** `backdrop-filter` fails on *both* generations
  (it is a function of what is behind it, and what is behind it is the woven buffer); on the
  draw-order path a pixel-moving `filter`, a non-normal blend mode or a 3D sorting context also
  keeps the element out of the lift. Near-solid backgrounds and plain quads instead.
- **One `createInline3D()` per document.** The element-rect channel is a whole-widget setter,
  so two live managers overwrite each other every frame (the SDK warns). Sequential sessions
  across routes are fine — `close()` the old one first.
- **The page still works in 2D.** Always ship a fallback for `{ supported:false }`.

## Under the hood (raw WebXR)

The SDK is thin; if you want the primitives:

- `navigator.xr.requestSession('inline-3d')` → a sensorless inline session. `RuntimeEnabled`
  by `DisplayXRInline3D`; only present in the DisplayXR Browser with inline-3D enabled.
- `session.requestReferenceSpace('viewer')`, then `session.requestAnimationFrame(cb)`; in the
  callback `frame.getViewerPose(refSpace).views` yields two `XRView`s, each with a
  `projectionMatrix` (off-axis frustum) and `transform.matrix` (eye world pose) updated to
  your tracked eyes every frame — the look-around.
- `XRDisplayLayer.prototype.occlusionByDrawOrder` — the readonly capability flag
  `inline3dOcclusionByDrawOrder()` reads. Absent on browsers that predate it, hence the
  `'occlusionByDrawOrder' in XRDisplayLayer.prototype && …` shape of the probe. Its deprecated
  neighbours `excludeElement` / `unexcludeElement` stay present-but-inert on such a browser, so
  they cannot stand in for it.
- `new XRDisplayLayer(session, canvas)` binds a canvas — **constructing the layer is the
  activation** (there is no `updateRenderState({layers})` step). The layer reports the
  canvas's live rect to the compositor each frame and exposes `getViewport(view)` (the SBS
  left/right split) and `close()`.

That's the whole surface. Everything else on this page is convention the SDK encodes for you.

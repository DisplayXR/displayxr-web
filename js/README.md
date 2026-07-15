# js/ — the inline-3D SDK

**`inline3d.js`** — a dependency-free ES-module SDK over the DisplayXR Browser's `inline-3d` WebXR
surface. One page, one WebXR session, MANY weaved windows — and any content:

- `createInline3D({ lazy, rootMargin, referenceSpace })` → the session + a manager, then:
  - `wall.addImage(canvas, urlOrImage, { cornerRadius, feather })` — a still side-by-side 3D photo
  - `wall.addVideo(canvas, videoEl, { … })` — an SBS 3D video (redrawn each frame)
  - `wall.addScene(canvas, onFrame, { virtualDisplayHeight })` — a live three.js/WebGL stereo scene;
    you get the two off-axis eye views each frame
- `startInline3D(canvas, { onFrame, virtualDisplayHeight })` → the one-element shorthand
  (`createInline3D({lazy:false})` + `addScene`). Returns `{ supported, close() }`, or
  `{ supported:false }` on any other browser so you can fall back to a mono render.
- `inline3DAvailable()` → cheap synchronous gate. It deliberately does NOT call
  `isSessionSupported('inline-3d')`: that async round-trip resolves FALSE if it runs before the OS
  weave service has bound (typically at page load), silently dropping you to 2D.

The runtime batches every visible window into ONE weave per frame, so a scrolling wall of 3D windows
stays cheap. The SDK keeps that working: it owns the side-by-side buffer contract, the lazy
create/close lifecycle, and — importantly — repaints each window every frame, because a canvas that
stops being redrawn drops out of the compositor's aggregated frame and the weave then reads a stale
sub-rect (which shows on screen as a horizontal smear).

Import directly — no build step:
```js
import { createInline3D } from '../../js/inline3d.js';
```

**`inline3d-three.js`** — optional three.js glue: `EyeCamera.setFromView(view)` drives a camera
straight from an `XRView`'s projection + pose. Scene scale is the runtime's job (the display rig's
`virtualDisplayHeight`), so there is no per-frame world scaling.

### Three things that bite (all fail deceptively)

1. **`renderer.setPixelRatio(1)`** for scenes. `layer.getViewport()` returns BACKING-STORE pixels,
   but three.js's `setViewport()`/`setScissor()` multiply by the renderer's pixelRatio — so any other
   value silently doubles each eye's viewport. The scene still head-tracks perfectly; it is just
   zoomed and off-centre, which reads as a projection bug rather than a viewport one.
2. **Size a scene canvas DOUBLE-WIDTH in device px** (`setSize(w*2, h, false)`): `getViewport()`
   splits `canvas.width` in half, and the browser squashing that 2:1 buffer into a 1:1 CSS box IS the
   SBS squeeze the weave un-squeezes. Mono fallbacks stay 1:1, or the flat render stretches.
3. **Keep the canvas visually bare** — no CSS `border`, `border-radius`, or shadow. The weave splits
   the element's rect down the middle, so spatially-varying decoration gets halved: each eye gets one
   edge and two corners, stretched 2x. Put page chrome on a wrapper, or use the SDK's per-eye
   `cornerRadius` / `feather`. A flat background is fine — both eyes get the same colour.

See `samples/hello-cube/app.js` (one scene) and `samples/windows/app.js` (photos + video + scene).

**`version-check.js`** — the DisplayXR Browser's lightweight update check (no silent auto-updater):
`checkForUpdate()` compares the running Chromium version against the latest `displayxr-browser` GitHub
Release; `showUpdateBanner()` renders a dismissible "new version → download" banner iff one exists. Meant
to run on the browser's start page. Never throws (offline / rate-limited / not-the-browser → no-op).

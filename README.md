# displayxr-web

Inline-3D **web samples** and a small JS SDK for the
[DisplayXR Browser](https://github.com/DisplayXR/displayxr-browser) — the DisplayXR analog of
[`immersive-web/webxr-samples`](https://github.com/immersive-web/webxr-samples). This is the canonical
repo web developers clone to build glasses-free 3D pages, and the site the browser navigates to for the
live demos.

**▶ See it live:** <https://displayxr.github.io/displayxr-web/> — open in the
[DisplayXR Browser](https://github.com/DisplayXR/displayxr-browser/releases) on DisplayXR hardware for
glasses-free 3D; in any other browser the pages render as a normal 2D fallback, so they're safe to view
anywhere.

## Install

The SDK is published as **[`@displayxr/inline3d`](https://www.npmjs.com/package/@displayxr/inline3d)**
(dependency-free ESM, ships its own TypeScript types):

```sh
npm install @displayxr/inline3d
```

```js
import { createInline3D } from '@displayxr/inline3d';
import { EyeCamera, EdgeFeather } from '@displayxr/inline3d/three'; // optional three.js glue
```

No build step or bundler required — it's plain ES modules. You can also import a pinned version by
URL from a CDN (jsDelivr / unpkg) without npm. The samples in this repo import the SDK by relative
path (`./js/inline3d.js`) so they run straight off GitHub Pages; in your own app prefer the package.

`three` is an **optional peer dependency** — only the `@displayxr/inline3d/three` helpers need it.

Stability & what's covered by semver (and the deferred N-view / web-components / CSS-native roadmap
that is intentionally **not** in 1.0): [`docs/sdk-stability.md`](docs/sdk-stability.md).

## Quick start

One SDK call turns a `<canvas>` into a glasses-free-3D window. Everything degrades to plain 2D on a
non-DisplayXR browser, so a page is safe to ship anywhere.

```js
import { createInline3D } from '@displayxr/inline3d';

const wall = await createInline3D();       // opens an inline-3d session (detects support)
if (!wall.supported) {
  // Not the DisplayXR Browser (or no 3D display) — your page's normal 2D content shows. Done.
} else {
  // Woven, glasses-free 3D. Add content — one call per element:
  wall.addImage(canvas, 'photo-sbs.png');                  // a still side-by-side 3D photo
  wall.addVideo(canvas, videoEl);                          // an SBS 3D video
  wall.addScene(canvas, (views, layer) => { /* render */ });// a live three.js / WebGL stereo scene
}
```

The browser weaves each element's stereo pair at its on-screen rect; the surrounding DOM stays flat.
The runtime batches every visible window into one weave per frame, so it scales to a wall of elements.

> **Detection:** call `createInline3D()` and check `wall.supported` — do **not** gate on
> `navigator.xr.isSessionSupported('inline-3d')`. That async probe resolves `false` if it runs before the
> OS weave service has bound (typically at page load), a false-negative that silently drops you to 2D.
> `createInline3D()` detects by actually acquiring a session, which is authoritative.

Full API + authoring guidance: [`docs/authoring-inline-3d.md`](docs/authoring-inline-3d.md).
Three.js glue (an off-axis `EyeCamera`) in [`js/inline3d-three.js`](js/inline3d-three.js).

## What's here

```
index.html            landing (Pages entry point)
samples/
  windows/            mixed 3D windows — still photos + a live video + a real-time three.js scene,
                      each woven with one SDK call, all on one session
js/
  inline3d.js         the SDK: createInline3D() → { addImage, addVideo, addScene }, feature-detect,
                      SBS buffer management, and a lazy create/close lifecycle for many windows
  inline3d-three.js   optional three.js helper (EyeCamera: off-axis projection from the session's eyes)
docs/
  authoring-inline-3d.md   the authoring guide
```

## The inline-3D model (under the SDK)

If you want the raw WebXR surface the SDK wraps, an inline-3d element:

1. `const session = await navigator.xr.requestSession('inline-3d')` — a sensorless inline session
   (feature-detect by whether this resolves; falls back to plain 2D).
2. `const layer = new XRDisplayLayer(session, canvas)` — binds the weave to that element.
3. Each XR frame: render the scene as a **side-by-side stereo pair** into the canvas, re-projected
   **off-axis** (asymmetric-frustum / Kooima) from the eye positions the session reports that frame —
   so moving your head looks *around* the 3D content.

See the [WebXR inline-3D explainer](https://github.com/DisplayXR/displayxr-runtime/blob/main/docs/roadmap/webxr-displayxr-explainer.md).

## Local preview

Any static server, e.g. `python -m http.server 8080`, then open `http://localhost:8080/`.
(Loading over `file://` is fine for pure-2D, but WebXR requires a **secure context** — use
`http://localhost` or `https://`.)

# displayxr-web

Inline-3D **web samples** and an optional JS helper for the
[DisplayXR Browser](https://github.com/DisplayXR/displayxr-browser) — the DisplayXR analog of
[`immersive-web/webxr-samples`](https://github.com/immersive-web/webxr-samples). This is the canonical
repo web developers clone to build glasses-free 3D pages, and the site the browser navigates to for the
live demos.

> Served via **GitHub Pages** (static). Open the samples in the DisplayXR Browser on DisplayXR hardware
> to see glasses-free 3D; in any other browser they render as a normal side-by-side stereo pair (or a
> flat fallback), so the pages are safe to view anywhere.

## What's here (planned)

```
index.html      demo gallery / landing (Pages entry point)
samples/        one folder per sample; each is a standalone static page
  hello-cube/     minimal three.js inline-3d cube (also the Step-B look-around eyeball)
js/             optional thin helper over XRDisplayLayer (feature-detect, boilerplate)
```

## The inline-3D model (what a sample does)

A normal responsive page with 2D content around one bordered `<canvas>` that:

1. `await navigator.xr.isSessionSupported('inline-3d')` (feature-detect; falls back to plain 2D/SBS).
2. `const session = await navigator.xr.requestSession('inline-3d')`.
3. `const layer = new XRDisplayLayer(session, canvas)` — binds the weave to that element.
4. Each XR frame: render the scene as a **side-by-side stereo pair** into the canvas, re-projected
   **off-axis** (asymmetric-frustum / Kooima) from the eye positions the session reports that frame —
   so moving your head looks *around* the 3D content.

The browser weaves that element's pre-weave pair at its on-screen rect; the surrounding DOM stays flat.
See the [WebXR inline-3D explainer](https://github.com/DisplayXR/displayxr-runtime/blob/main/docs/roadmap/webxr-displayxr-explainer.md).

## Status

**Scaffolding.** Samples land in a follow-up session (P4 of the
[packaging plan](https://github.com/DisplayXR/displayxr-runtime/blob/main/docs/roadmap/displayxr-browser-preview.md)).
Tracking: [displayxr-runtime#733](https://github.com/DisplayXR/displayxr-runtime/issues/733).

## Local preview

Any static server, e.g. `python -m http.server 8080`, then open `http://localhost:8080/`.
(Loading over `file://` is fine for pure-2D, but WebXR requires a **secure context** — use
`http://localhost` or `https://`.)

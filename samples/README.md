# samples/ — inline-3D web samples

The DisplayXR analog of `immersive-web/webxr-samples`. Each sample is a normal static page with one (or
more) `inline-3d` element(s); open them in the DisplayXR Browser on a DisplayXR display for glasses-free
3D, or any browser for the flat fallback.

| Sample | What it shows |
|---|---|
| [`hello-cube/`](hello-cube/) | The "hello world": a bordered `<canvas>` requesting an `inline-3d` session + `XRDisplayLayer`, rendering a rotating cube as an off-axis stereo pair (look-around) inside an otherwise flat 2D page. |

All samples use the SDK in [`../js/inline3d.js`](../js/inline3d.js) (plus the optional three.js glue in
[`../js/inline3d-three.js`](../js/inline3d-three.js)). three.js is loaded from a pinned CDN via an
import map — no build step.

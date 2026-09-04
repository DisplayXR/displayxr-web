# Samples

Vanilla HTML/JS pages that import the SDK from `../../js/` (or a pinned CDN build) through an
import map. Every one of them renders as ordinary 2D outside the
[DisplayXR Browser](https://github.com/DisplayXR/displayxr-browser), so they are safe to open
anywhere. The landing page that lists them — and that the browser opens at startup — is the
repo's root [`index.html`](../index.html), published at
<https://displayxr.github.io/displayxr-web/>.

| Sample | What it shows |
|---|---|
| [`hello-cube/`](hello-cube/) | The minimum complete page: one rotating three.js cube in a woven canvas. |
| [`camera-rig/`](camera-rig/) | The **camera rig**: the page sends its own orbiting camera each frame instead of a virtual-display height. Convergence, comfort, the `attach` pattern, and <kbd>C</kbd> to A/B it against a display rig. |
| [`windows/`](windows/) | Mixed producers — still photos, a live side-by-side video and a real-time three.js scene, all on one session. |
| [`wall-3d/`](wall-3d/) | A long lazy-loading scrolling wall: layers created as tiles near the viewport, closed as they leave. |
| [`demo-gallery/`](demo-gallery/) | A grid of the DisplayXR demo logos woven as tiles — the compact multi-element weave. |
| [`sticky-header/`](sticky-header/) | The chrome-occlusion path: a sticky translucent bar the wall scrolls under, with no page wiring. |
| [`composition/`](composition/) | **The 14-case 2D/3D overlap matrix** — demo *and* standing hardware regression surface (see below). |
| [`splat/`](splat/) | A 3D Gaussian splat tile via `addSplat()`, auto-framed, with a 2D price plate over it. |
| [`model/`](model/) | `addModel()`: a glTF mesh, a mesh + splat sharing one scene, and a Draco-compressed glTF. |
| [`shop/`](shop/) | A shoppable storefront whose product hero has depth (a built Next.js export). |
| [`overlay-test/`](overlay-test/) | A minimal diagnostic repro for the 2D-overlay aspect path — a probe, not a showcase. |

## `composition/` — the composition showcase

Fourteen numbered cases covering every hard 2D-over-3D and 3D-vs-3D overlap on one scrollable
page: translucent bars, frosted glass (fully covering and straddling an edge), opaque plates,
a page-DOM modal, a ~10 Hz plate thrash, partial visibility at all four viewport edges, a nested
`overflow:auto` panel, a sticky tile with content passing behind *and* over it, a zoom sweep,
edge-adjacent tiles, overlapping tiles, the 3D→2D→3D sandwich, and a mixed
scene + video + photo load.

It has two jobs, and the second constrains the first: **nothing on it is tuned to look good.**
Cases that glitch today are built anyway and marked red on-page — case 07 until
[browser#117](https://github.com/DisplayXR/displayxr-browser/issues/117) lands, case 12 because
tile-over-tile is not yet defined. A case softened until it passes is not a regression test.

**Reading order and the frost pair.** The page runs the healthy cases first — **01**, then
**04–14** — and puts **02** and **03** last, behind a red *KNOWN BROKEN* banner. Those two are
the full-tile `backdrop-filter` cases, and on hardware they hit
[browser#120](https://github.com/DisplayXR/displayxr-browser/issues/120): a frost rect covering
a whole tile carries neither the suppressed canvas nor the clipped-out weave, so the blur samples
nothing and the tile reads as a black void. Opening the page into them made the whole sample look
broken. Both therefore ship **unfrosted** — plain translucent panels with the tiles weaving —
and each carries an *arm frost* button (`__showcase.frost('02', true)`) that adds the
`backdrop-filter` live, so they stay one-click #120 repros. Case numbers never move; only the
DOM order did. The page's own sticky header keeps its frost on purpose: a thin (~56 px) band
over page chrome is the validated, working case, and case 07's top-edge leg needs it.

Authoring rules it holds to, which are worth copying into any page that composes 2D over 3D:

- **One `createInline3D()` per document**, closed on `pagehide`. The browser's element-rect
  channel is a whole-widget setter; two live sessions overwrite each other's rect list every
  frame.
- **`autoChrome: false`** — that flag is the SDK's legacy-browser exclusion scan, and this page
  measures pure draw-order occlusion, so no SDK-side exclusion machinery may participate.
- **Zero exclusion-era API**: no `exclude()`, no `addGlobalOverlay()`, no
  `data-inline3d-overlay`. Every 2D element is an ordinary DOM sibling painted after the canvas.
- **No synthesised media** — the stills come from `demo-gallery/assets/`, the video and the
  crate textures from `windows/assets/`. The video is **VP9/WebM**: stock Chromium builds ship
  with proprietary codecs off, so an `.mp4` fails with `MEDIA_ERR_SRC_NOT_SUPPORTED`, which
  reads exactly like a broken path and is not one.

Every section carries a stable `data-case="NN"` and every canvas a `data-tile`, so a hardware
session can be scripted:

```js
document.querySelector('[data-case="07"]').scrollIntoView();
__showcase.snap('v', 'top', 0.1);   // park the sweep tile at 10% visibility, top edge
__showcase.thrash(true);            // case 06
__showcase.modal(true);             // case 05
__showcase.frost('02', true);       // arm the browser#120 frost repro (cases 02 / 03)
```

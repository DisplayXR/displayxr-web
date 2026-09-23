# auto-3D for existing three.js pages — prototype

Turns an ordinary, already-published three.js page into a woven glasses-free-3D window in the
DisplayXR Browser, **with no change to the page**: no SDK import, no WebXR, no source edit. It is a
prototype for measuring coverage on real sites, in the same spirit as `tools/immersive-shim/`
(which does the same for WebXR `immersive-vr` pages). It is not a product and must not ship as one.

## How it works

- **Finding three.js on any page.** three.js (r105 and later) announces every `WebGLRenderer` it
  constructs to a global `__THREE_DEVTOOLS__` EventTarget, if one exists. `content.js` runs in the
  page's MAIN world at `document_start`, defines that global before any page script, and so
  receives every renderer — bundled, minified, or loaded from a CDN alike.
- **Taking over the draw, not the page.** `render()`, `setSize()` & co. are instance properties, so
  they are wrapped per renderer. The page keeps its own loop, camera, controls and DOM:
  - the canvas backing store becomes the side-by-side (SBS) pair the weave expects, while the page
    keeps seeing its mono size (`getSize`, `getPixelRatio`, `getViewport`, `canvas.width` … are
    virtualised, so the usual `canvas.width !== clientWidth * dpr` resize check stays quiet);
  - each `render(scene, perspectiveCamera)` to the screen becomes one render per eye, into its
    half, from the eye poses and off-axis projections the session reports (the attach pattern:
    eye world = page camera × `view.transform`, identity rig pose);
  - other screen draws (an ortho HUD pass, a post-processing quad) go identically into both halves:
    flat, never a broken tile;
  - a **camera rig** is pushed every session frame from the page camera, with an automatic
    convergence distance and a `metersToVirtual` that scales with it, so depth reads the same in
    any scene units (comfort `ipd × m2v × diopters × 0.5` = the `depth` setting, default 0.3);
  - a frame the page did not draw (render-on-demand pages) is **replayed** from its last screen
    draws, so the tile is redrawn every frame and head motion still looks around;
  - a still of the last mono frame covers the canvas for 1.2 s after the layer is created (the
    `firstWoven` hold, [woven-canvas rules](../../docs/woven-canvas-rules.md) rule 5).
- **Standing down.** It yields for good in a document the moment the page asks for inline-3D
  itself (an SDK page), or for `immersive-vr` / `immersive-ar` (a WebXR page's Enter VR — the
  immersive shim's job), and when a renderer presents through `renderer.xr`. One inline-3D session
  per document, as the SDK requires.

## Why a renderer shim, not the alternatives

- **Duplicating WebGL commands** (the 3D Vision approach) works for any engine, but it has to guess
  which draws depend on the view: shadow maps, post-processing passes and UI all look alike at the
  GL level. NVIDIA needed per-game profiles for exactly this.
- **Synthesising the second eye from the depth buffer** costs one render, but it leaves holes at
  edges, gives transparent objects and particles the depth of what is behind them, and has no
  meaningful depth under post-processing. The runtime also has no view synthesis by design: the app
  renders every view.
- **Doing either inside Chromium** keeps the same trade-offs and adds a patch to carry on a fork
  that is rebased every month.
- **A three.js-level shim** renders real geometry for each eye from the runtime's own views, uses
  only the public inline-3D surface, and can ship the way the immersive shim did (as a component
  extension) once it earns it.

## Try it

**A — in your own DisplayXR Browser (recommended).** `chrome://extensions` → *Developer mode* →
*Load unpacked* → select this folder. Then open or reload a three.js page.

**B — a separate profile.** First close **every** DisplayXR Browser window: a second browser
instance gets no weave slot and stays 2D forever
([displayxr-browser#162](https://github.com/DisplayXR/displayxr-browser/issues/162)). Then run
`launch.cmd [url]` (non-elevated).

Pages to start with:

| Page | What it exercises |
|---|---|
| `https://threejs.org/examples/webgl_animation_keyframes.html` | a continuous loop, a model on a turntable |
| `https://threejs.org/examples/webgl_animation_skinning_blending.html` | a character, shadows |
| `https://threejs.org/examples/webgl_geometry_teapot.html` | render-on-demand (the replay path) |
| `https://threejs.org/examples/webgl_shadowmap.html` | a reversed-depth renderer |
| `https://threejs.org/examples/webgl_postprocessing_unreal_bloom.html` | a post-processing chain: stays 2D in v0.1 |

## Controls

`Ctrl+Alt+…` — **3** on/off for this site (remembered per origin) · **=** / **-** depth ·
**0** / **9** convergence farther / nearer · **8** reset · **D** HUD. The HUD (bottom left) shows
the depth, the convergence distance, and counts of stereo / flat / replayed frames.

`window.__dxrAuto3D.state()` reports every renderer seen, what was converted and why not;
`window.__dxrAuto3D.probe()` asks the live layer for `getDisplayInfo()` / `getRenderingModes()`.
Console lines are tagged `[dxr-auto3d]`.

## What converts, what stays 2D (v0.1.0)

| Page | Result |
|---|---|
| one `WebGLRenderer`, a `PerspectiveCamera` drawn straight to the screen | **3D** |
| render-on-demand (draws only on input) | **3D**, idle frames replayed |
| reversed-depth renderer (`reversedDepthBuffer: true`) | **3D** (eye projection converted to reversed-Z) |
| extra screen passes after the scene (HUD, overlay) | **3D** scene, flat overlay |
| several viewports in one canvas | flat per viewport |
| post-processing chain (the screen pass is a full-screen quad) | **2D** — needs per-eye render-target twins (next) |
| `WebGPURenderer` | **2D**, skipped |
| three.js r104 and older, OffscreenCanvas / worker rendering | not seen |
| canvas or an ancestor with opacity < 1, filter, mask, clip-path, blend mode | waits, stays 2D while the effect is there |
| a second renderer in the same document | 2D (one converted canvas per document) |

## Verified, and what is not

**On the display (2026-09-23):** loaded unpacked into the DisplayXR Browser 154.0.8037.17 on an SR
display, `webgl_animation_keyframes` converts and shows. That is a first look; depth comfort,
flicker at the switch and frame rate have not been assessed yet.

Checked the same day through CDP on a **second, headless** DisplayXR Browser instance (another
instance held the display's weave slot — browser#162 — so this one had no weave), with the script
injected by `Page.addScriptToEvaluateOnNewDocument` — the same main-world, before-page-scripts
timing as this extension:

- renderers are found on threejs.org (r186, import-map modules) and on production sites (r158–r183);
- the inline-3d session and the `XRDisplayLayer` are granted; `setViewRig` is accepted;
- with test-only synthetic eyes (`__dxrAuto3DTestCfg = { fakeViews: true }`) the stereo path runs
  without page exceptions; with the layer withheld (`noLayer: true`) the raw SBS pair screenshots
  correctly and its halves differ by a depth-dependent parallax;
- at DPR 3 a page using the per-frame `canvas.width` resize check keeps seeing its mono size
  (3732) while the store is capped at 3072 — one reallocation in 7 s, no per-frame thrash;
- a render-on-demand page (teapot: 1 page draw) was redrawn 378 times by replay;
- SDK samples (`hello-cube`, `model`) and a WebXR page's `immersive-vr` request make it yield.

**Not verified — needs the DisplayXR display and a human:** that the weave shows 3D, the real
runtime views, the cover timing against the real join, whether `depth` 0.3 and the automatic
convergence are comfortable, and frame rate (every converted draw call runs twice).

Measured on that weave-less instance, and handled: a canvas with a layer bound is withheld from
the page and never woven (a blank tile), and `getDisplayInfo()` resolves `null` with no rendering
modes — so the script goes back to 2D within ~1.5 s there. `drawImage()` from a bound canvas also
returns an empty image, which is why the cover is a still.

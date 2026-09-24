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
import { addSplat } from '@displayxr/inline3d/splat';               // experimental: 3DGS in a tile
import { addModel } from '@displayxr/inline3d/model';               // experimental: glTF/GLB in a tile
                                                                    //   (Draco / meshopt / KTX2 too —
                                                                    //    you serve the decoder files)
import { SceneViewer } from '@displayxr/inline3d/viewer';           // experimental: framing + orbit
```

No build step or bundler required — it's plain ES modules. You can also import a pinned version by
URL from a CDN (jsDelivr / unpkg) without npm. The samples in this repo import the SDK by relative
path (`./js/inline3d.js`) so they run straight off GitHub Pages; in your own app prefer the package.

`three`, `@sparkjsdev/spark`, `playcanvas` and `meshoptimizer` are **optional peer dependencies**
— the core is dependency-free and only the scene subpaths need them (`/model` needs `playcanvas`,
or `three` with `engine: 'three'`). The two viewer subpaths are
**experimental**: they turn "one object in a tile, look around it, drag to spin" into a single
call (auto-framing on the zero-disparity plane, orbit, idle turntable, mono fallback), but their
API is not yet covered by the semver promise below.

**A second splat engine (preview).** `addSplat(wall, canvas, src, { engine: 'playcanvas' })`
renders the same splat window with the [PlayCanvas](https://playcanvas.com/) engine instead of
Spark — same handle, same rig/focus/camera-block behaviour, same `perf` presets (mapped onto the
engine's knobs) — and adds `setSource(src, { fadeMs })` (crossfading asset swaps), `feather`, a
tilt-and-relax orbit, two-finger pinch plus bounded zoom that relaxes back to rest
(`zoom: { min, max, relax }`, [§Zoom bounds and relax](docs/playcanvas-adapter.md#zoom-bounds-and-relax)), `handle.engine` (the engine objects, for advanced pages) and
`handle.setRig('display' | 'camera' | 'auto')`: a live, reversible rig switch, so one persistent tile
can show a glTF under `handle.engine.root` exactly as `addModel` would and then go back to the photo's
capture rig ([§setRig](docs/playcanvas-adapter.md#setrig--switching-between-the-display-rig-and-the-camera-rig-36)), and
`handle.setVideo(src, { format: 'sbs' | 'tb' | 'mono' })`: a stereo video on that same tile, each eye
its own half, with no second canvas ([§setVideo](docs/playcanvas-adapter.md#setvideo--a-stereo-video-on-the-persistent-handle-36)). It needs the
optional peer `playcanvas` (`>=2.22.3 <3`) and reads `.sog`, `.ply` and a Streamed-SOG
`lod-meta.json`. **Spark stays the default**; a page that never passes `engine` never loads
`playcanvas`. What differs, and why: [`docs/playcanvas-adapter.md`](docs/playcanvas-adapter.md).
Bundlers: the engine is reached through a named-import module (`js/inline3d-playcanvas-engine.js`,
so the unused ~40% of the engine tree-shakes away); its sort workers are Blob URLs (CSP
`worker-src blob:`), and esbuild needs `node:worker_threads` marked external.

**Splat effects (preview, `engine: 'playcanvas'`).** Shader effects on the splats themselves,
keyed on world position and time so both eyes agree: `addSplat(…, { reveal: 'inflate' | 'sweep' |
'dissolve' | 'fade' | 'assemble' | 'dissolve-in' | 'converge' | 'shimmer' })` (plays once the tile
is woven; the last four are particle reveals), `handle.playEffect` / `setEffect` / `stopEffect` /
`effects()` (the reveals, deflate, pulse, grade, clip, custom GLSL), and `setSource(src, { transition: 'crossfade' | 'flip' | 'wavefront', reveal })`. Spark
throws on all of them for now. [`docs/splat-effects.md`](docs/splat-effects.md).

Splat and model rendering on the PlayCanvas backend uses the PlayCanvas engine (MIT); see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

**Models render with PlayCanvas by default (1.12).** `addModel(wall, canvas, 'chair.glb')` loads
the glTF with the PlayCanvas engine (optional peer `playcanvas`), lit to match the Khronos glTF
Sample Viewer: an in-memory neutral studio environment, Khronos PBR Neutral tone mapping,
exposure 1. `environment: 'room'` gives three's RoomEnvironment look instead (a page tuned on the
three path). `engine: 'three'` is the 1.11 three.js renderer, unchanged (also importable as
`@displayxr/inline3d/model/three`). Each engine is imported only when a tile asks for it. Draco
and KTX2 use the same served decoder folders on both engines. Design, the Sample-Viewer MAE table
and what throws: [`docs/playcanvas-model-backend.md`](docs/playcanvas-model-backend.md).

**Large scenes stream (preview).** On `engine: 'playcanvas'`, a Streamed SOG streams: pass the URL
of its `lod-meta.json` (or of its directory), not its bytes. The engine fetches only the chunks
the view needs and draws at most `perf.splatBudget` of them. That budget is per tile and shared
by every view of the tile; it defaults to 600k on a Streamed SOG. `handle.stats()` reports what
is resident. This is for big captured scenes, several million gaussians and up. A photo lift is
one dense sheet that is fully on screen, so it gains nothing from streaming. How to produce, serve
and budget one, with measurements:
[`docs/playcanvas-adapter.md` §Streamed SOG](docs/playcanvas-adapter.md#streamed-sog-p2).

**A game owns its camera (preview).** `addSplat(wall, canvas, src, { engine: 'playcanvas',
controls: 'page', onBeforeFrame })` hands the camera to the page. Call
`handle.setCameraPose(matrixWorld, { verticalFovDeg, near, far, convergence? })` inside
`onBeforeFrame` and that frame renders it. The SDK runs no orbit, idle spin, fit or focus
gestures. It keeps the eye math: the attach-pattern camera rig (the auto-3D shim's, with
`comfortDepth` 0.3 by default), the runtime's projections, and the mono fallback. Spark refuses
this mode. Contract and numbers:
[`docs/playcanvas-adapter.md` §controls:'page'](docs/playcanvas-adapter.md#controlspage--the-page-owns-the-camera).

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

Most pages want the default — a **display rig**, where the canvas is a portal onto a virtual
display and the runtime places the eyes. That includes every scene that frames a *subject* (a model
or splat viewer, an avatar, a product hero) **even when the user orbits it**: rotate the subject,
not the camera, and the stereo comes out the same for a figurine and an airliner.

A scene whose viewpoint the user *moves through a world* — first person, a walkthrough, a game, a
map, an editor, a ported VR app — can instead hand its own camera to the runtime and let eye
tracking perturb that frustum. That is a **camera rig**:

```js
import { cameraRigFromCamera } from '@displayxr/inline3d/three';
const handle = wall.addScene(canvas, onFrame, { viewRig: cameraRigFromCamera(THREE, cam, { convergence: 1.2 }) });
handle.setViewRig(cameraRigFromCamera(THREE, cam, { convergence: 1.2, out: rig }));  // per frame
```

No projection math lands in your page or in the SDK — the off-axis frustum stays in the runtime. See
[view rigs](docs/authoring-inline-3d.md#view-rigs-display-vs-camera) and
[`samples/camera-rig/`](samples/camera-rig/).

> **Detection:** call `createInline3D()` and check `wall.supported` — do **not** gate on
> `navigator.xr.isSessionSupported('inline-3d')`. That async probe resolves `false` if it runs before the
> OS weave service has bound (typically at page load), a false-negative that silently drops you to 2D.
> `createInline3D()` detects by actually acquiring a session, which is authoritative.

Full API + authoring guidance: [`docs/authoring-inline-3d.md`](docs/authoring-inline-3d.md).
Before you ship a page that navigates or remounts, read
[`docs/woven-canvas-rules.md`](docs/woven-canvas-rules.md): how to avoid a raw side-by-side
flash, and releasing a poster on `handle.firstWoven`.
Three.js glue (an off-axis `EyeCamera`) in [`js/inline3d-three.js`](js/inline3d-three.js).

## What's here

```
index.html            landing (Pages entry point)
samples/
  camera-rig/         the camera rig — an orbiting scene that sends its OWN camera each frame;
                      convergence + comfort, the attach pattern, C to A/B a display rig
  windows/            mixed 3D windows — still photos + a live video + a real-time three.js scene,
                      each woven with one SDK call, all on one session
  splat/              a 3D Gaussian splat in a tile, auto-framed, with a 2D price plate over it
  model/              a glTF mesh, a mesh+splat scene, and a Draco-COMPRESSED glTF (PlayCanvas; ?engine=three)
  composition/        the 14-case 2D/3D overlap matrix — demo AND standing hardware regression
                      surface; red cases ship red (see samples/README.md)
vendor/draco/         three's Draco decoder, served for samples/model (compressed glTF needs it)
js/
  inline3d.js         the SDK: createInline3D() → { addImage, addVideo, addScene }, feature-detect,
                      SBS buffer management, and a lazy create/close lifecycle for many windows
  inline3d-three.js   optional three.js helper (EyeCamera: off-axis projection from the session's eyes)
  inline3d-viewer.js  experimental: SceneViewer — framing, orbit, idle turntable, mono fallback,
                      and the placement readback (getSubjectBounds / getPose / depthOffset)
  inline3d-splat.js   experimental: addSplat() — a Gaussian splat window via Spark
                      (`perf` cuts overdraw; a `.sog`'s `camera` block picks the view rig)
  inline3d-splat-playcanvas.js
                      preview: the `engine: 'playcanvas'` backend of addSplat(), loaded on demand
  inline3d-model-entry.js       experimental: addModel() — picks the engine (PlayCanvas default)
  inline3d-model-playcanvas.js  the PlayCanvas model backend (Sample-Viewer lighting, engine decoders)
  inline3d-model.js             the three.js model backend (engine:'three'; ./model/three)
  inline3d-playcanvas-engine.js named playcanvas imports for both PlayCanvas adapters (tree-shaking)
  inline3d-splat-effects.js     splat shader effects: the runner, the effect registry (PlayCanvas)
  inline3d-splat-live.js        setSource's live outgoing photo: its own camera, layer and target (PlayCanvas)
                      from what the asset declares (you serve the decoder files — see the guide)
docs/
  authoring-inline-3d.md   the authoring guide
  authoring-motion-and-effects.md
                           motion, transitions and per-eye effects — the half of authoring
                           that is not the API
  porting-three-js-apps.md porting an existing three.js app (WebXR or plain) to inline 3D —
                           the WebXR→inline-3d mapping table and the whole render loop
  woven-canvas-rules.md    never show a raw side-by-side frame: the join, the eight rules,
                           handle.firstWoven, reading the browser's `withheld` log line
  proposals/               browser-side asks the SDK is waiting on
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

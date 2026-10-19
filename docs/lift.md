# lift — Convert to 3D

**EXPERIMENTAL** — the `./lift` subpath is preview tier (docs/sdk-stability.md). This page is the
overview and the integration contract; the explore renderer has its own page:
[explore renderer](lift-explore.md).

> **The runtime converts (ADR-053, P4).** This SDK carries no model, no ONNX Runtime, no in-page
> depth, no depth-image-based renderer and no lift generator. The conversion is done by the
> DisplayXR runtime's conversion stack (an open provider by default, a vendor module when one is
> installed) and reached through the DisplayXR Browser; [`native.js`](../js/lift/native.js) is the
> SDK's only provider. Where there is no converter (`liftCapabilities().native` is false), `lift()`
> rejects with a `NativeLiftError` (`code: 'unavailable'`) and the page keeps its own 2D element.
> The in-page pipeline (`depth-ort`, `inpaint-ort`, `live-dibr`, `lift-gen`, `models.json`, the
> stubs) and its pages (`lift-models.md`, `lift-dibr.md`, `lift-gen.md`) were removed with it.

`lift(element, opts)` turns an ordinary `<video>` or `<img>` on a page into 3D **in place**:
a video plays as **live** 3D (the browser converts and weaves the element itself), and on an explicit
*Explore* the paused frame is **lifted** by the runtime into a small 3D Gaussian scene you can
**explore** with a bounded orbit. A still goes straight to explore.

```js
import { lift, resolveMediaAt } from '@displayxr/inline3d/lift';

const h = await lift(document.querySelector('video'));   // rejects (unavailable) without a converter
h.on('statechange', ({ state, from, reason }) => console.log(from, '→', state, reason));
h.on('progress', ({ phase, value }) => {});   // phase: 'lift', value 0..1
h.on('error', ({ error, fatal }) => {});      // fatal=false: a lift hiccup, still usable
h.setDepth(1.4);
h.stats;       // { state, fps, loadMs, generateMs, exploreLoadMs, pauseToExploreMs, splats, ... }
h.setOrbit(8); // explore: turn the lifted scene (degrees, clamped to the orbit cap)
h.explore();   // freeze + lift now (pauses a playing video)
h.resume();    // back to the live view of the PAUSED frame at once (abandons any in-flight lift; never plays)
h.play();      // explicit playback (the page's own controls do the same); its `play` event → live
h.remove();    // unmounts; the element is exactly as it was

// "Convert whatever is under the pointer":
addEventListener('click', (e) => { if (e.altKey) { const el = resolveMediaAt(e.clientX, e.clientY); el && lift(el); } });
```

The explore renderer needs the SDK's optional peer `playcanvas` (≥ 2.22.3 < 3), resolvable as a bare
specifier (an import map or a bundler), exactly like `addSplat(…, { engine: 'playcanvas' })` — it is the
PlayCanvas splat viewer (docs/lift-explore.md; it replaced three + Spark in 2026-09).

Sample: [`samples/lift/`](../samples/lift/) — open it in the DisplayXR Browser (the runtime converts).
Locally:

```sh
python3 samples/lift/serve.py        # no-store cache headers, correct MIME
open 'http://127.0.0.1:8812/samples/lift/index.html'
```


## Options

| option | default | |
|---|---|---|
| `mode` | `'live'` for a video, `'explore'` for a picture | `live`: the browser converts the element in place; a pause never builds a splat (no lift request, no `.sog`); only Explore does. `auto`: also lifts on pause/end. `explore`: lift as soon as the element is ready — the default for a picture (straight to the splat view, no `dxr-lift` attribute, no stream). A stated mode is honoured: `'auto'` on a video lifts on pause; `'live'` on a picture keeps the browser's in-place conversion (Explore / Resume toggle). |
| `depth` | `1` | depth strength multiplier: `dxr-lift-strength` for the live conversion, and in explore the lifted scene's depth about its pivot (`setDepth()` drives both). |
| `convergence` | `'auto'` | zero-disparity depth (`dxr-lift-convergence`). |
| `quality` | `'auto'` | `low`/`medium`/`high`, handed to the lift provider; `auto` picks `medium` on a desktop with ≥ 4 GB and ≥ 4 cores, else `low` — **never `high`**. |
| `wall` | — | an existing `createInline3D()` manager to join. **Pass it if the page already has one** — one inline-3D session per document. |
| `orbit` | `{ maxAngleDeg: 15, relax: true }` | explore orbit bounds; `relax` springs back to centre on release. |
| `providers` | `{}` | `lift`: the lift stage — omitted = the runtime's `native-gaussians` (when its caps list `gaussians`); `'remote-sharp'` = the **demo-only** remote SHARP provider (see *Remote SHARP*); or a `LiftProvider` instance. With no runtime converter and no `providers.lift`, `lift()` rejects (`unavailable`). |
| `remote` (alias `remoteSharp`) | `{}` | factory options for a named `providers.lift`: remote-sharp's `{ endpoint, auth, timeoutMs, mode, getAuthHeaders, fields, maxBytes }`. |
| `exploreMaxDpr` | 1 woven / ∞ flat | dpr cap on the canvas while explore is up. 1 on the woven SBS store unless `quality: 'high'`. |
| `explore` | `{ comfort: 'auto', pivotTargetM: 2.0, eyes: 'nominal' }` | the explore view. `comfort: 'auto'` scales a **metric** lift about the camera so its pivot lands at `pivotTargetM` when it is > 25 % off (neutral image unchanged, parallax × pivot/target — the paused-CG-video "too flat" fix); `'always'` / `'off'` for A/B. `eyes: 'tracked'` takes the runtime's eye positions as metres instead of normalising their separation to 63 mm. docs/lift-explore.md § Comfort. |
| `ui` | `'builtin'` | a small chip (progress %, Explore / **↓ SOG** / Resume / Exit) in the element's corner; `'none'` = drive the handle yourself. `{ autoHideMs }` = the builtin chip with options: it fades out after that many ms without pointer activity over the element (**default 2500 with a runtime converter**, 0 = always visible otherwise; see *Chrome over the tile*). |
| `signal` | — | `AbortSignal`; aborting removes the lift. |
| `native` | `'auto'` | the browser's conversion stack ([Vendor modules](#vendor-modules-native-mode)). `auto`: used for a `<video>`/`<img>` when `liftCapabilities()` says `native`; `false`: never; a caps object skips the query. |
| `priority` | `'normal'` | native live: `dxr-lift-priority` (`high`/`normal`/`low`/`paused`). |

Handle: `state`, `element`, `canvas`, `layout` (`standard`/`picture`/`aspectRatio`/`overlay`),
`woven` (true = inline-3D session, false = 2D fallback), `stats`, `on(type, cb) → off`, `off`,
`explore()`, `resume()`, `play()`, `setOrbit(yaw, pitch)`, `setDepth(x)`, `setConvergence(x)`,
`exportSog({camera?}) → Promise<Blob>`, `downloadSog(filename?) → Promise<boolean>`, `canExport`,
`capture() → Promise<Blob>` (the next drawn frame as a PNG, read back in the same task as the draw —
the canvas has `preserveDrawingBuffer: false`, so a page screenshot between frames can show it empty),
`remove()`. `stats` adds `exploreScale` (the comfort scale applied), `mode` (`native`/`provider`) and
`provider` (the vendor module's name). Native mode adds `native`, `caps`, `setPriority(p)` and
`priority`. Types: [`lift.d.ts`](../lift.d.ts).

## Vendor modules (native mode)

**The runtime converts.** The DisplayXR runtime's conversion stack — an open provider by default,
a vendor module when one is installed — is exposed by the DisplayXR Browser, and it is this SDK's
**only** provider. Concretely:

| | the runtime's converter (`native`) |
|---|---|
| live `<video>` / `<img>` | the **browser** converts + weaves the element **in place** (`dxr-lift="auto"`): no canvas, no model, no JS per frame |
| paused-frame depth (optional) | `native` DepthProvider → `POST displayxr-lift://lift/depth` (registered at priority 100, stills only) |
| explore scene | `native-gaussians` LiftProvider → `POST displayxr-lift://lift/gaussians`, the default `providers.lift` when `modes` includes `gaussians` (a 404 sticks). Without `gaussians` there is no explore scene: `explore()` is a lift error |

There is **no fallback**: an error from the module is the lift's error, and a `<canvas>` is not
converted. Pause → explore is freeze → `lift/gaussians` → PlayCanvas explore, ↓ SOG. The two POST
endpoints and `caps` answer **only inside the browser's lift isolated world** (where the built-in
runs); on any ordinary page the scheme does not resolve, `fetch` rejects, and that rejection is the
feature detection.


**`liftCapabilities({signal})`** — cheap, async, **never cached** (every
call asks the browser afresh; `refresh` is accepted and ignored), callable before any lift (a
3D-calling element uses it to badge its peers):

```js
{ native: true, provider: 'neurd-directml', modes: ['depth','sbs','nview','gaussians'],
  maxStreams: 2, approxMsPerConvert: 18, state: 'ready',          // as GET displayxr-lift://caps says
  liftState: 'ready' }                                             // waiting | ready | unavailable
```

`native` is true only when the browser says so **and** `liftState !== 'unavailable'`. `liftState` is
the browser's coarse readiness (an older browser's `state: 'activating'` maps to `waiting`).
**`waiting` is a reason to wait, never a reason to switch paths:** create the lift anyway (the
element shows its own 2D frame, the chip a spinner, until the browser's converter is READY) and do
not keep a `waiting` answer beyond one poll interval (≤ 2 Hz) — a cached non-READY answer is how
a cold-booted runtime once latched the wrong path for a whole session. Only `unavailable` ends the
lift: the element stays the page's own 2D element.

**What `lift()` does.** It mounts the placement host (hidden canvas + chip) but not into the
inline-3D session; the element stays visible and gets the attributes below. Loading pulls in
nothing: the explore renderer loads on the first explore. A `<video>` is **live** (browser-converted)
until `explore()` — the default mode is `live` for a native video, so a paused video stays woven 3D
by the vendor module and nothing is lifted until *Explore*; *Resume* goes back to the paused frame.
A **picture** goes **straight to explore**: `loading → freezing → lifting → explore`, no live phase,
no `dxr-lift*` attribute written — the frame's depth (`lift/depth`) / gaussians (`lift/gaussians`)
are fetched for the explore scene without any live stream. With `ownLiftAttr` a `dxr-lift` the
browser's menu pre-set is removed at once. Its chip is **↓ SOG + Exit** only (no Explore / Resume,
no "3D" label; the label shows only while converting or on error); a lift failure is an `error`
(there is no live view to fall back to), and `resume()` does not apply. Entering explore sets `dxr-lift="off"` (the SDK's canvas
owns those pixels), hides the element and adds the canvas to the session; leaving it restores the
element and `dxr-lift="auto"` at once, and the canvas fades out and leaves the session. A hidden tab
holds `dxr-lift-priority="paused"`. `remove()` (and a fatal error) restores every attribute to its
pre-lift value — including one the page set itself — unless `ownLiftAttr: true`: then the caller
owns the element's lift state and every `dxr-lift*` attribute is **removed** on exit, whatever was
there before `lift()`. The browser's built-in passes it: its context menu (`lift_trigger.cc`) sets
`dxr-lift="auto"` before `lift()` runs, and restoring that "auto" on Exit / toggle-off left the
element converting with no handle — a second *Convert to 3D* then double-converted. `handle.setDepth/setConvergence/setPriority`
update the attributes live; `state` is `live`, `stats.mode` is `'native'`.

**Attributes** (on the `<video>`/`<img>`; the browser reads them):

| attribute | values | set from |
|---|---|---|
| `dxr-lift` | `auto` \| `off` | `auto` while live; `off` while explore owns the pixels |
| `dxr-lift-convergence` | `auto` \| number | `convergence` / `setConvergence()` |
| `dxr-lift-strength` | number (≥ 0) | `depth` / `setDepth()` |
| `dxr-lift-priority` | `high` \| `normal` \| `low` \| `paused` | `priority` / `setPriority()`; `paused` while the tab is hidden |

**Wire formats** the SDK accepts (the browser patch, N2, is the producer):

- `POST displayxr-lift://lift/depth`, body = the frame as an image (JPEG, the frame's own size).
  Answer either **binary** — `application/octet-stream`, body `w·h` little-endian float32 row-major,
  headers `X-DXR-Depth-Width`, `X-DXR-Depth-Height`, `X-DXR-Depth-Semantics`, optional
  `X-DXR-Depth-FocalPx` (in pixels of the `w×h` grid) — or **JSON** `{w, h, semantics, focalPx?, data}`
  (`data` base64 float32 or a number array). `semantics`: `metric` (metres, 0 = invalid) or
  `disparity` (relative inverse depth, bigger = nearer; aliases `inverse-depth`,
  `relative-disparity`). Anything else is a `format` error.
- `POST displayxr-lift://lift/gaussians`, same body. Answer a `.sog` (sniffed `PK\x03\x04`; its camera
  block v2 is the rig) or a `.ply` (sniffed `ply\n`) **with** an `X-DXR-Lift-Meta` JSON header
  (`{focalPx, w, h, pivotZ?, axes?}`, the generator's meta shape). The PLY is in the generator's
  frame: **OpenCV** — camera at the origin looking **+z**, **y down**, each splat at its pixel's
  unprojection `X = (u − w/2)·Z/focalPx`, `Y = (v − h/2)·Z/focalPx`, `Z` = its depth in metres;
  `pivotZ` (default 2) the depth that sits on the glass. A header without `axes`/`convention` is
  read as `axes: 'opencv'` (`'opengl'` = looking −z, y up, if the module says so). A scene at
  `z ≤ 0` is behind/at the camera and draws nothing. 404/501 = not supported.
- Errors are `NativeLiftError` with `code` `http | unsupported | unavailable | format | encode | network | aborted`
  (`unavailable`: `lift()` found no converter at all).

**The built-in** (docs/lift-builtin.md) asks `liftCapabilities()` first and, when native, only sets the
attributes and mounts the chip — up to `caps.maxStreams` native conversions side by side.

Browser harness (not `npm test`, needs a GPU browser; not re-run since the P4 deletions):
`node test/lift-native.run.mjs` runs the real `lift()` on an `<img>` and a `<video>` with
`displayxr-lift://` faked in `window.fetch`.

## Download SOG (`js/lift/sog-export.js`)

After a conversion the chip shows **↓ SOG** (explore state); `handle.downloadSog()` does the same from
the page, `handle.exportSog()` returns the Blob. The file is a PlayCanvas **SOG v2** bundle built
entirely in the page — no Worker, no `canvas.toBlob`, no network — that the gallery, `addSplat` (both
engines), the PlayCanvas engine and the native gauss demo open **on the photo's own camera rig**:

- **Container** (what the engine's `SogBundleParser` / `GSplatSogData` read @ 2.22.3): a PKZip of
  STORED entries — `meta.json`, `means_l.webp` / `means_u.webp` (16-bit positions, `n = sign·ln(|v|+1)`
  over per-axis `mins/maxs`, low/high byte), `quats.webp` (smallest-three, `A = 252 + largest`),
  `scales.webp` + `sh0.webp` (indices into 256-entry 1-D k-means codebooks over the log scales / the
  f_dc; `sh0.A` = sigmoid(opacity)·255). Texels row-major, `width = ⌈√n/4⌉·4`, splats in the lift's
  image scan order.
- **Lossless WebP, written in JS** (`js/lift/webp-lossless.js`: VP8L, subtract-green + a left
  predictor, Huffman literals, no LZ77). Not `canvas.toBlob('image/webp', 1)`: a 2D canvas stores
  PREMULTIPLIED alpha, so `sh0`'s RGB (alpha = opacity) and `quats`' (alpha 252–255) cannot survive it
  whatever the encoder does; libwebp's `dwebp` decodes every plane of a real export bit-exactly, and
  `test/lift-sog-export.test.mjs` round-trips through a spec decoder.
- **Camera block v2** in `meta.json`, right after `count` (the shape the gallery producer writes;
  `sogCameraFromMeta` validates it):
  `{convention:'opencv', rig:'camera', rest:{position:[0,0,0], rotation:[0,0,0,1]},
  intrinsics:{fx, fy, cx, cy, width, height} (meta.intrinsics — the generator's output raster),
  focus:{point:[0,0,pivotZ], subject_m, near_m, far_m, source:'convergence'},
  dxr:{ipd_factor, parallax_factor}}` — `focus.point` = orbit centre = pivot = convergence (pivotZ =
  min(convergence, subject), the gallery rule). No `stereo` key (one camera). The file stays metric;
  when explore applied its comfort scale k the `dxr` factors are `1/k`, the camera rig's way of saying
  "eyes this many world units per real metre", so a viewer honouring the block reopens it with the
  stereo the explore view had. `exportSog({ camera: {...} })` merges overrides (e.g. a manual focus).
- **Measured** (office photo, 904,821 splats, Chrome, M1 Pro): 760–920 ms to build, 8.0 MB (vs a 61.5 MB
  PLY); max position error 48 µm, opacity ≤ 0.5/255, quaternion 1 − |q·q'| ≤ 3e-5. Reopened by
  `samples/splat/?engine=playcanvas&url=…` and `?engine=spark`: rig `camera`, focus source `block`,
  convergence 2.917 m, and the rest view is the photo.

## State machine (`js/lift/state.js`)

```
            start            loaded (video)
  idle ───────────▶ loading ───────────────▶ live ◀───────────── play / emptied / seeked-while-playing
                       │  │                   │  ▲                         │
                  fail │  │ loaded (still,     │  │ play                    │
                       ▼  │ or mode:explore)   │  │                         │
                    error │     pause (150 ms  │  │                         │
                          │     debounce) /    ▼  │                         │
                          └──────────────▶ freezing ──frozen──▶ lifting ──lifted──▶ explore
                                  ended /     ▲ seeked-while-paused (new gen)          │
                                  explore()   └────────────────────────────────────────┘

  live | loading | freezing | lifting | explore ──hidden──▶ suspended ──visible──▶ (where it was)
  any ──remove / element disconnected──▶ disposed        any ──fatal──▶ error
```

- **Pause is debounced 150 ms** (`PAUSE_DEBOUNCE_MS`); a pause that is undone inside the window never
  lifts, and a scrub (many `seeked` while paused) schedules one lift, not one per seek.
- **Generation counter.** Every freeze gets a new `gen`; `frozen` / `lifted` / `lift-failed` carrying
  an older gen are dropped. A provider that ignores its `AbortSignal` still cannot land a stale view.
- `play` in explore **crossfades** back to live (uses the explore renderer's `fadeOut` if it has one).
- **Play never waits on explore work.** `play` / `playing` on the `<video>`, or *Resume* / `resume()`,
  while freezing, lifting or in explore goes `live` **in the same tick**, native `dxr-lift` attributes
  restored in that tick: the in-flight work — still-depth fetch (native `lift/depth` included), the
  lift provider (remote SHARP fetch), the local generator (its worker is terminated), a `.sog`
  export (stops at its next yield) — is abandoned through its `AbortSignal` and the generation bump,
  never awaited. A result that arrives later belongs to an abandoned generation and is dropped
  silently (a `console.debug` line, no `error` event, no state change). Pause → explore is only
  acceptable because the way back is instant.
- **Resume returns to the PAUSED frame; only an explicit play plays.** *Resume* / `resume()` leaves
  explore for the live view of the paused frame (native: `dxr-lift="auto"`, the browser weaves the
  paused frame) and **never calls `play()`**. Playback starts only on an explicit play — the page's
  player controls or keyboard, or `handle.play()` — and its `play` event returns to live as above
  (from explore too: a play the page starts while exploring is treated as explicit).
- **Explore input stays ours.** The explore canvas swallows every pointer / mouse / click / touch
  event it gets (`stopPropagation` + `preventDefault`, incl. the synthetic `click` after a drag), and
  the chip stops propagation of its own; a player under the element (YouTube toggles play on click)
  never sees them — an orbit drag used to unpause the video on release. `contextmenu` (the browser's
  Convert-to-3D menu) and `wheel` (page scroll) are not swallowed. The canvas takes `touch-action:none`
  while interactive, so a touch drag orbits instead of scrolling.
- `seeked` while playing → `provider.reset()` (temporal models must not blend across a cut).
- `ended` → explore the last frame immediately.
- `emptied` / `loadstart` (src swap) → reset, stay live.
- Element removed (per-frame `isConnected` + a `MutationObserver`) → `disposed`, element restored.
- `visibilitychange` hidden → `suspended`: inference stops, models stay loaded. An in-flight lift is
  cancelled and restarted on return if the video is still paused.
- `ResizeObserver` / window resize / devicePixelRatio change → canvas re-placed and re-allocated.
- Lift failure on a video is **non-fatal** (back to live, `error` with `fatal:false`); on a still it is
  fatal (nothing else to show). Fatal errors hide the canvas and leave the page's element visible.

## Placement (`js/lift/placement.js`)

A port of the Immersity Lens approach. `resolveMediaAt(x, y)` scans the whole `elementsFromPoint`
stack (looking *through* overlays, into open shadow roots, and resolving hits inside a player's chrome
such as YouTube's `.html5-video-player` to its `<video>`), then falls back to the
`findImgInParentsAndSiblings` walk (own subtree, then siblings, ≤ 5 levels). Candidates must be
≥ 50 px with aspect 0.2..5.

`mountCanvas(el)` inserts a host in the element's own container (layout modes: `standard`,
`picture` — next to the `<picture>`, `aspectRatio` — inside a padding-bottom ratio box, `overlay` —
absolute/fixed/transformed media, z-index + 1). The host matches the element's **content box**, holds
the canvas in a **closed shadow root**, and the canvas matches the visible media pixels per CSS
`object-fit` / `object-position` (a video's letterbox comes from `videoWidth/Height`). When object-fit
crops (`cover`, `none`), the lift provider reads a crop of the visible part. `pointer-events`
is `none` in live (page and player controls keep working) and `auto` in explore (drag to orbit).
The element itself is never modified; `unmount()` removes the host.

## Session

All lifts in a document share **one** `createInline3D()` manager — the page's (`opts.wall`) or a
private one created on first use and closed when the last lift is removed. The canvas is a normal
`addScene()` window: the SDK calls back with `(views, layer, frame)` and lift forwards
`{ views, layer, session }` to explore. The backing store is SBS (2 × width) while a
session is live. Without inline-3D, the same frame function runs from `requestAnimationFrame` with one
mono view and a full-canvas `getViewport` — the 2D fallback. If the session ends (`onLayerLost`), the
lift continues on the fallback loop. The builtin chip is registered with the window's `exclude()`.

## Provider interfaces

- `js/lift/explore.js`: `createExplore({canvas, ply|sog, meta, axes?, clearAlpha?, orbit:{maxAngleDeg, relax}, depthGain?, space?, comfort?, eyes?}) → Promise<{ render({views, layer, session}), onPointerDown/Move/Up(ev), setTarget(yaw,pitch), fadeIn(ms), fadeOut(ms), setDepthGain(x), dispose() }>` (async: the PlayCanvas engine parses the scene and owns the canvas's WebGL2 context).
- `js/lift/sog-export.js`: `exportSog({ply|splats, meta, camera?}) → Promise<Blob>` (a `.sog` with the camera block v2; see *Download SOG*).
- `js/lift/native.js`: `liftCapabilities()`, `createNativeDepthProvider(opts)` (a DepthProvider; extra opt `fetch`; rejects on error), `createNativeGaussiansLift()` (a LiftProvider: `{id:'native-gaussians', needsDepth:false, generateLift({rgb,signal,onProgress}) → {sog} | {ply, meta}}`), `ensureNativeProviders(caps)` — see *Vendor modules*.
- **LiftProvider** (`js/lift/providers/registry.js` `registerLiftProvider(name, factory, {priority, optIn})` / `getLiftProvider(name, opts)`): `{ id, needsDepth, load?(), generateLift({rgb, quality, params, signal, onProgress}) → Promise<{ply?: ArrayBuffer, sog?: ArrayBuffer, meta}>, signIn?(), dispose?() }`. `meta` carries `focalPx, pivotZ, w, h, layers, splatCount, source`. A provider may return **`sog`** instead of `ply`; `createExplore({sog})` then reads the rig from the file's camera block v2 (`js/lift/sog-input.js`: `intrinsics` → focalPx/w/h, `focus.point[2]` → pivotZ, OpenCV axes), so the neutral view is the photo. Selection: `providers.lift` by name; with no name the runtime's `native-gaussians`. A provider error ends the lift (`lift-failed`, a non-fatal `error` with `phase: 'lift'`): there is no local lift to fall back to.

### How lift.js uses them (the parts the contracts leave open)

- **One canvas, one WebGL2 context.** Explore creates the canvas's context (the engine); `capture()` reads the same one back.
- **Optional `fadeOut(ms)`** on the explore renderer is used for the explore → live crossfade when
  present; without it the switch is a cut.
- **Axes.** A PLY from the runtime is the OpenCV camera frame (`meta.convention` / `meta.axes =
  'opencv'`); explore defaults to OpenGL, so lift passes `axes: meta.axes || meta.convention`.
- **Opaque explore.** Explore clears opaque black (`clearAlpha: 1`). With a transparent clear, every
  pixel the splat sheet did not fully cover showed the page's own flat `<img>`/`<video>` underneath —
  a ghost double of the foreground under the orbit.
- **Progress.** The chip shows the provider's progress (`{stage,progress}`); lift normalises.
- **dpr.** While explore is up the canvas is capped at `exploreMaxDpr` (default 1 on the woven SBS
  store; the mono 2D fallback held 60 fps at dpr 2).


## Known issues

- **Explore load is ~0.3 s slower than on Spark** (the engine parses the PLY on the main thread:
  `exploreLoadMs` ~520 ms vs ~220 ms for 0.9 M splats). Rendering is faster and stall-free
  (docs/lift-explore.md § Performance).
- **Comfort scaling applies to metric lifts.** A scene whose pivot is more than 25 % from 2 m gets
  scaled; needs a panel check; `explore: { comfort: 'off' }` restores the unscaled view.


## Media codecs

The DisplayXR Browser is built without proprietary codecs: `<video>` sources must be VP9 or AV1 (WebM/MP4). An H.264/HEVC source never reaches `loadeddata`; `lift()` then fails fast with a `MediaError` (`code 4`, `MEDIA_ERR_SRC_NOT_SUPPORTED`) and an `error` event instead of staying in `loading`. YouTube serves VP9/AV1, so it is unaffected.

## Chrome over the tile (chip, buttons, overlays)

Anything the lift draws over its own woven tile must use a **near-solid background and no `backdrop-filter`** (the authoring guide's config C3). A frosted element over a tile makes the DisplayXR Browser send that tile raw — the panel shows side-by-side instead of 3D — until the element leaves the tile. This was hit on the first panel test with the builtin chip.

**Native mode: the chip is inside the lift crop, so it gets woven.** In native mode the browser — not the SDK — converts the element: it crops the element's whole on-screen rect out of the page raster, converts it and weaves the vendor's SBS result back into the same rect. Every pixel inside that rect is treated as video content, so the builtin chip (top-right corner, inside the rect) is converted and woven with it — seen on the panel. Until the browser splits planes for lift rects, the chip **auto-hides in native mode** (`ui: { autoHideMs }`, default 2500 ms): it fades out (~150 ms, then `visibility:hidden`, so it never intercepts the pointer while hidden) after that long without a `pointermove`/`pointerdown` over the element or the chip; any move or press over them shows it again and restarts the timer; keyboard focus on a chip button keeps it up; progress and provider notes (*Lifting with SHARP… 7s*) and state changes re-show it briefly. With no runtime converter (a caller-supplied provider only) nothing is woven under the chip, so its default is 0 — always visible. A page with its own UI can pass `ui: 'none'`.


## Remote SHARP (demo only)

`lift(el, { providers: { lift: 'remote-sharp' }, remote: { endpoint, auth } })` lifts the paused frame /
still on a **remote SHARP worker** instead of in the page: Apple's SHARP single-image Gaussian
predictor (the gallery's Modal `sharp-sog` worker), 1152×1024×… = 1,179,648 gaussians, a ~10–14 MB `.sog`,
explored in the same PlayCanvas explore view (the file's own camera block is the rig).
`js/lift/providers/lift-remote-sharp.js`, `createRemoteSharpLift({ endpoint, timeoutMs, mode, auth })`.

> **Licence — demo use only.** SHARP's weights are under Apple's **ML Research Model License**:
> research purposes only, *no commercial exploitation or use in a commercial product or service*,
> and the restriction follows fine-tuned derivatives. The provider is opt-in (never a default),
> ships no model, and **must not be part of an OEM / product distribution**. It also needs the
> network, sends the frame to a third-party GPU, and costs GPU time per lift.

- **Wire.** `POST endpoint` multipart: `mode=mono`, `image` = the frame as JPEG (long side ≤ 1536 px,
  q 0.92 — SHARP resamples to its fixed 1536² grid anyway; a hard **4 MB** cap re-encodes smaller,
  because the gallery relay runs on Vercel, which rejects bodies over 4.5 MB), `focal_length_px` only
  when the caller knows it (in pixels of the JPEG sent — lift.js skips local depth on this path, so
  normally none is sent and the worker uses its default; the JPEG carries no EXIF). Answer: the `.sog`.
- **Endpoint.** Default `/api/sharp/predict` on the **page's own origin**: a server there adds the
  worker's bearer token, so a page never holds it (`samples/lift/serve.py`, below). A hosted relay
  (the gallery's `POST /api/sharp/predict`, Google-allow-listed, cached, rate-limited — its
  `docs/sharp-relay.md`) takes `auth: { kind: 'google', loginUrl: '<gallery>/auth/popup' }`: the
  provider opens `loginUrl?origin=<page origin>` in a centred 480×640 popup, accepts only
  `postMessage({ type: 'dxr-auth', accessToken, expiresAt, email })` **from that origin**, keeps the
  token in memory until 30 s before `expiresAt`, sends `Authorization: Bearer`, and re-opens the popup
  once on a 401. Open it from a click (`provider.signIn()`), or a lift started by a video pause will be
  popup-blocked. `auth: { kind: 'bearer', token }` and `getAuthHeaders()` exist for other hosts.
  Relay headers `X-DXR-Sharp: cache-hit|modal` and `X-DXR-Sharp-Ms` land in `meta.cacheHit` /
  `meta.serverMs` and the chip.
- **Progress** (`progress` events, `phase: 'lift'` with `stage` + `elapsedS`): `encoding`, `uploading`,
  `waiting` (ticks every 250 ms), `downloading` (bytes / Content-Length). The chip reads
  "Lifting with SHARP… 7s", then "Downloading SHARP scene (cached)…".
- **Failures** are `RemoteLiftError` (`code`: `timeout` (default 90 s), `network`, `http`, `auth` (401
  after the one re-login), `forbidden` (403 — "account not allowed"), `quota` (429, `retryAfterS`),
  `too-large` (413), `format` (not a `.sog`), `popup-blocked`, `popup-closed`, `aborted`). Every one but
  `aborted` falls back to the local MoGe-3 + generator lift, with the reason on the chip
  ("SHARP quota reached — lifting locally"); `stats.liftFallback` records it.
- **Download SOG** after a remote lift returns the worker's **original bytes** (its own camera block);
  `exportSog({ camera })` overrides are ignored there.
- **Stats.** `liftSource` (`'remote-sharp'` | `'local'`), `remoteMs`, `remoteTimings` (`encodeMs`,
  `requestMs`, `downloadMs`, `totalMs`, `bytes`, `cacheHit`, `serverMs`).
- **Latency / cost** (worker README): ~8.5 s warm, ~40 s cold on a Modal L4 (scale-to-zero), plus the
  ~10–14 MB download. Client side, measured (M1 Pro, headless Chrome, 2026-09-25, `samples/lift/`
  through `serve.py --sharp` against a local stand-in worker replaying Apple SHARP's output for the same
  JPEG): encode 30–50 ms (1536×1021, 285 kB), proxy + 12.5 MB download 20–60 ms on localhost, `.sog`
  explore load 115–135 ms (vs 490–600 ms for the local PLY). Everything else is the worker.
- **Quality vs the local lift** (tamarra2k, yaw −10/0/+10): SHARP's disocclusions are filled with
  plausible background and hair — none of the local lift's stretched streaks behind the shoulder or
  cut-outs along the arm — and the neutral view is the photo. But SHARP predicts nothing outside the
  frame: at ±10° the leading edge shows ragged black (the local lift's outpaint border covers it).
  With no EXIF (the JPEG is re-encoded) the worker assumes a 30 mm-equivalent lens.
- **Explore from a `.sog` on the lift canvas** needed two engine fixes (`js/lift/explore.js`):
  `TextureHandler` registered (a `.sog`'s webp planes are texture sub-assets — without it every
  `.sog` explored BLACK), and the GL state re-adopted around the load, which issues a GPU pass
  (the sort centres) and immediate texture uploads from async continuations between the live conversion's
  frames (it mis-sorted into a translucent, smeared foreground). The GPU gate that compared a `.sog` with a
  PLY explore of the same lift (`test/lift-sog-explore.run.mjs`) built its PLY with the removed local
  generator and went with it.

**Running it locally** — the proxy is in the dev server; the values stay in your shell:

```sh
export DXR_SHARP_URL=…     # = the gallery's MODAL_SHARP_URL (the worker base URL; /v1/predict is appended)
export DXR_SHARP_TOKEN=…   # = the gallery's MODAL_SHARP_TOKEN (Modal secret `sharp-auth`, SHARP_SHARED_TOKEN)
python3 samples/lift/serve.py 8812 --sharp      # POST /api/sharp/predict → $DXR_SHARP_URL/v1/predict + bearer
open 'http://127.0.0.1:8812/samples/lift/index.html?image=/_scratch/photos/tamarra2k.jpg&lift=remote-sharp'
```

The proxy forwards the multipart body unchanged, streams the answer back (only `Content-Type`,
`Content-Length`, `X-Sharp-*`, `X-DXR-Sharp*` pass through), bounds the call with `DXR_SHARP_TIMEOUT`
(s, default 180), maps an upstream 401/403 to 502 (it is *our* token that is wrong), and never logs
or returns the token. Sample query: `lift=remote-sharp`, `sharp=<endpoint>` (default the proxy),
`auth=google` [+ `login=<popup URL>`, default `<endpoint origin>/auth/popup`; a **Sign in for SHARP**
button appears], `timeout=<s>`. For a cross-origin popup serve with `--allow-popups`
(`Cross-Origin-Opener-Policy: same-origin-allow-popups`): `same-origin` severs the popup, which then
reads as closed at once and cannot post back.

## Dev serving

Serve the repo root with `python3 samples/lift/serve.py [port]` (no-store cache headers, correct MIME for `.mjs`/`.wasm`/`.onnx`/`.webm`). Plain `python -m http.server` sends no cache headers, so Chrome can keep running stale SDK modules after a `git pull`.

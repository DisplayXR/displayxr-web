# lift — Convert to 3D

`lift(element, opts)` turns an ordinary `<video>`, `<img>` or `<canvas>` on a page into 3D **in place**:
a video plays as **live** 3D (per-frame monocular depth + depth-image-based rendering), and when it
pauses or ends the frame is **lifted** into a small 3D Gaussian scene you can **explore** with a
bounded orbit. A still goes straight to explore. On the DisplayXR Browser the canvas weaves
glasses-free; everywhere else it renders the same pipeline as a single mono view (the 2D fallback).

```js
import { lift, resolveMediaAt } from './js/lift/lift.js'; // package subpath: integrator's call

const h = await lift(document.querySelector('video'));
h.on('statechange', ({ state, from, reason }) => console.log(from, '→', state, reason));
h.on('progress', ({ phase, value }) => {});   // phase: 'models' | 'depth' | 'lift', value 0..1
h.on('error', ({ error, fatal }) => {});      // fatal=false: live/lift hiccup, still usable
h.setDepth(1.4);
h.explore();   // freeze + lift now (pauses a playing video)
h.resume();    // back to live (plays the video; its `play` event crossfades explore → live)
h.remove();    // unmounts; the element is exactly as it was

// "Convert whatever is under the pointer":
addEventListener('click', (e) => { if (e.altKey) { const el = resolveMediaAt(e.clientX, e.clientY); el && lift(el); } });
```

Sample: [`samples/lift/`](../samples/lift/) (runs on stubs; `?providers=real` for the real models).

## Options

| option | default | |
|---|---|---|
| `mode` | `'auto'` | `auto`: live while playing, lift on pause/end. `live`: never lifts by itself (`explore()` still does). `explore`: lift as soon as the models are in. |
| `depth` | `1` | depth strength multiplier (live DIBR). |
| `convergence` | `'auto'` | zero-disparity depth; handed to live-DIBR as given. |
| `quality` | `'auto'` | `low`/`medium`/`high`; `auto` picks from `deviceMemory`/`hardwareConcurrency`/mobile UA. Providers always get a concrete tier. |
| `wall` | — | an existing `createInline3D()` manager to join. **Pass it if the page already has one** — one inline-3D session per document. |
| `orbit` | `{ maxAngleDeg: 15, relax: true }` | explore orbit bounds; `relax` springs back to centre on release. |
| `models` | `'auto'` | a `ModelSource`, or `'auto'` for `createModelSource({})`. |
| `providers` | `{ video: 'vda-small', still: 'moge3', inpaint: 'iw3-light' }` | `still` also accepts `'da3'`, `'da2-small'`. |
| `ui` | `'builtin'` | a small chip (progress %, Explore / Resume / Exit) in the element's corner; `'none'` = drive the handle yourself. |
| `signal` | — | `AbortSignal`; aborting removes the lift. |
| `backend` | `'real'` | `'stub'` swaps in `js/lift/stubs/*` (same contracts, no ML) — development and demos only. |

Handle: `state`, `element`, `canvas`, `layout` (`standard`/`picture`/`aspectRatio`/`overlay`),
`woven` (true = inline-3D session, false = 2D fallback), `on(type, cb) → off`, `off`, `explore()`,
`resume()`, `setDepth(x)`, `setConvergence(x)`, `remove()`.

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
crops (`cover`, `none`), the providers and the DIBR read a crop of the visible part. `pointer-events`
is `none` in live (page and player controls keep working) and `auto` in explore (drag to orbit).
The element itself is never modified; `unmount()` removes the host.

## Session

All lifts in a document share **one** `createInline3D()` manager — the page's (`opts.wall`) or a
private one created on first use and closed when the last lift is removed. The canvas is a normal
`addScene()` window: the SDK calls back with `(views, layer, frame)` and lift forwards
`{ views, layer, session }` to live-DIBR / explore. The backing store is SBS (2 × width) while a
session is live. Without inline-3D, the same frame function runs from `requestAnimationFrame` with one
mono view and a full-canvas `getViewport` — the 2D fallback. If the session ends (`onLayerLost`), the
lift continues on the fallback loop. The builtin chip is registered with the window's `exclude()`.

## Provider interfaces

These are fixed; each module is built against them independently.

- `js/lift/providers/depth-ort.js`: `createDepthProvider({kind:'video'|'still', modelSource, ort?, quality}) → DepthProvider` with `id, kind, load({signal,onProgress}), estimate({source: HTMLVideoElement|HTMLImageElement|HTMLCanvasElement|VideoFrame|ImageBitmap, t}) → Promise<{data: Float32Array /*row-major h×w*/, w, h, space:'disparity'|'metric', intrinsics?:{focalPx}}>, reset(), dispose()`. Disparity is relative, larger = nearer, un-normalised.
- `js/lift/providers/models.js`: `createModelSource({baseUrl?, manifest?}) → { get(name) → Promise<{stream, size, sha256}>, url(name) }`, plus `loadOrt({baseUrl}) → ort` and `getRegistry()` with `registerDepthProvider(name, factory, {priority})`.
- `js/lift/live-dibr.js`: `createLiveDibr({canvas /*WebGL2*/}) → { setSource(el|VideoFrame), setDepth({data,w,h,space}), setParams({depth, convergence, dilate}), render({views, layer, session}) /* draws every view into layer.getViewport(view), same convention as addScene callbacks */, dispose() }`.
- `js/lift/gen/lift-gen.js`: `generateLift({rgb: ImageBitmap|HTMLCanvasElement, depth:{data,w,h,space,intrinsics}, inpainter?, quality, signal, onProgress}) → Promise<{ply: ArrayBuffer /*binary 3DGS PLY*/, meta:{focalPx, pivotZ, w, h, layers:2}}>`.
- `js/lift/explore.js`: `createExplore({canvas, ply, meta, orbit:{maxAngleDeg, relax}}) → { render({views, layer, session}), onPointerDown/Move/Up(ev), setTarget(yaw,pitch), fadeIn(ms), dispose() }`.

### How lift.js uses them (the parts the contracts leave open)

- **One canvas, one WebGL2 context.** Live-DIBR and explore are both created on the same canvas, so
  `getContext('webgl2')` returns the same context to both. Each must set the GL state it needs on
  every `render()` (program, VAO, textures, blend, viewport) and must not assume the other left it
  clean. While explore fades in, lift renders DIBR first and explore on top — so explore must **not
  clear** while its fade alpha is < 1 (the stub clears only at full opacity).
- **Optional `fadeOut(ms)`** on the explore renderer is used for the explore → live crossfade when
  present; without it the switch is a cut.
- **Provider selection.** `providers.video/still` names are looked up in the registry via
  `getDepthProvider(name)` (or `get(name)`) when the registry offers such a lookup; otherwise
  `createDepthProvider` is called. Either way the factory receives `{kind, modelSource, ort, quality,
  model: name}` — `model` is an extra field outside the contract so a single factory can pick the
  network by name.
- **Inpainter.** `inpainter` is taken from `registry.getInpainter(providers.inpaint)` when the registry
  has one, else `undefined` (the generator's default).
- **Convergence** is passed to `setParams` as given (`'auto'` or a number); live-DIBR resolves `'auto'`.
- **Live inference** runs at most one `estimate()` at a time, only on a new video frame, and depth
  that arrives after a `reset()` is discarded. The frozen frame's still-model depth is also pushed to
  live-DIBR, so the paused frame looks its best while the lift runs.
- **Progress.** The chip shows one bar per phase group: models 0–25 %, depth 25–35 %, lift 35–100 %.

## Stubs (`js/lift/stubs/`)

Same contracts, no ML: a luminance + bottom-is-nearer ramp for depth, a one-pass backward-warp DIBR,
a point-grid PLY generator (two layers, INRIA property layout), and a point-sprite explore renderer.
In the mono 2D fallback the DIBR and explore stubs sway slowly so the page visibly shows the pipeline
running. Use `backend: 'stub'`.

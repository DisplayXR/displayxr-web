# lift built-in — the DisplayXR Browser's "Convert to 3D" bundle

The DisplayXR Browser ships [`lift`](lift.md) as a **built-in**. The user right-clicks an image or a
video and picks *Convert to 3D*. The browser (`displayxr-browser-pvt` patches 0220–0223 and the
native lift patches after them) injects one classic script into a dedicated isolated world and calls it:

```js
/* displayxr-lift-builtin.js */                // once per document
__dxrLift.convertAt(x, y, 'video');            // per pick; x, y = visual-viewport CSS px
```

> **The runtime converts (ADR-053, P4).** The bundle carries no model, no ONNX Runtime, no in-page
> depth, no live view synthesis and no lift generator. It is the chip, the explore view and the SOG
> export; the conversion is the runtime's, reached through the browser. There is no in-page
> converter to fall back to: where the runtime offers none the element stays the page's own 2D.

This page covers how the script is built, what it needs at runtime, and how it is staged.
The source is in [`tools/lift-builtin/`](../tools/lift-builtin/).

## API

`globalThis.__dxrLift` is a frozen, non-enumerable, non-writable object:

| member | |
|---|---|
| `convertAt(x, y, mediaType, hint)` → `Promise<{ok, reason?, action?, mode?}>` | Resolves the media under the point with the SDK's `resolveMediaAt`, after mapping visual-viewport px to client px (`visualViewport.offsetLeft/Top`, `/ scale`) and preferring an element of `mediaType` (`'image'`\|`'video'`\|`'canvas'`). It **refuses** with a reason when there is no media at the point, the video has `mediaKeys` (EME), the image is not loaded, the pick is a `<canvas>` (`canvas-not-supported`), or the runtime has no converter (`converter-unavailable`). **Toggle**: if the element is already lifted, the lift is removed (`action:'removed'`). Up to `caps.maxStreams` conversions coexist (oldest evicted). Calls are serialised. The promise never rejects. |
| `setLiftState(state)` | The browser's coarse state push (`waiting` \| `ready` \| `unavailable`); see *Waiting is not a failure*. |
| `cancelAll()` | Removes every lift and restores the elements. |
| `status()` | Returns a plain-data snapshot for DevTools: version, worker mode, the last caps, the pushed state, and each lift's state and `stats`. It exposes no handles and no elements. |
| `version` | `<SDK version>+<short commit>` (a `.dirty` suffix marks an uncommitted tree). |

`lift(el, { ui: 'builtin', native: caps, ownLiftAttr: true })` does everything else: live 3D while a
video plays (the browser converts it), explore on an explicit *Explore* or for a still, and the chip with
*Explore / Resume / Exit* (*Resume* goes back to the paused frame, never plays — the page's own player
controls do that; a drag in explore never reaches the player). It passes **no `mode`**, so it takes
the SDK default: a **video** is `live` — a paused video stays woven 3D by the runtime's converter and
nothing is lifted until the chip's *Explore* — and a **picture** goes **straight to explore** (the
Gaussian view, chip = *↓ SOG / Exit* only, no live stream and no `dxr-lift` attribute: the one the
menu pre-set is removed at once, since the built-in passes `ownLiftAttr`).

**The browser decides first.** The browser's menu decides whether the runtime takes the element and
passes it as `convertAt`'s 4th argument `{native, liftState}` (browser patch 0331); with no 4th
argument (an older browser) `convertAt` asks `liftCapabilities()` itself — afresh on every pick,
**never cached**. When the runtime converts, `lift()` sets `dxr-lift="auto"` (+
strength/convergence/priority) on the element, the browser converts + weaves it in place, and the chip
offers *Explore / Exit* (*↓ SOG* in explore). The built-in passes **`ownLiftAttr: true`**: it owns the
element's lift state (the browser's menu has already set `dxr-lift="auto"` when `lift()` runs), so the
chip's *Exit*, a toggle-off `convertAt` and `cancelAll()` — all of which end in `handle.remove()` —
**remove** every `dxr-lift*` attribute instead of restoring the menu's "auto". *Explore* asks the
runtime for a Gaussian scene (`POST displayxr-lift://lift/gaussians`, docs/lift.md § Vendor modules);
a module without `gaussians` has no explore scene and the pick reports a lift error.
`convertAt` resolves `mode: 'native'`; `status()` adds `caps` and each lift's `native`.

**Waiting is not a failure.** The browser's coarse lift state is `waiting | ready | unavailable`
(never a provider name). `waiting` — the runtime's converter is warming, e.g. right after a cold boot —
still takes the lift: the element keeps its own 2D frame, the chip's label shows a spinner ("Starting
3D…", no *Explore* yet), and the browser converts the element by itself the moment its converter is
READY. The browser pushes every change into the lift world as `__dxrLift.setLiftState(state)`, which
forwards it to each handle (`handle.setLiftState`, event `liftstatechange`). Only `unavailable` ends
the lift: the browser reports it when the runtime has no lift at all, or when an old runtime (lift
spec ≤ 3, or one with no provider) has not come up within the browser's wait budget; a lift that never
reached READY is then removed and the element is the page's own 2D element.

## Browser hosting

**Runtime files** come from the pak as `displayxr-lift://runtime/<file>`. Anyone may request them. The
only file is `displayxr-lift-builtin.js`; it is not fetched by the bundle: the browser reads it from the
pak and runs it in the world. (Until the P4 deletions the pak also carried the ONNX Runtime files and
`models.json`, and the store served `displayxr-lift://models/<name>`; both are gone — a request for
either is a stale bundle and answers 404.)

**The lift endpoints** answer **only requests from the lift world** (`isolated_world_origin`):
`displayxr-lift://caps`, `displayxr-lift://lift/depth` and `displayxr-lift://lift/gaussians`
(docs/lift.md § Vendor modules).

**The world's CSP** is `script-src 'self' displayxr-lift: 'wasm-unsafe-eval'; object-src 'none';
connect-src displayxr-lift: https:`. It has no `unsafe-eval`, no `data:` or `blob:` fetch, and no `blob:`
workers (`worker-src` falls back to `script-src`). The bundle is built for that:

- **No `import.meta`, no static `import`, no `import()`**: the build fails if any survives.
- **No wasm.** The explore renderer is the PlayCanvas engine. The scene is handed to the engine as
  in-memory bytes (`file.contents`), never a `blob:` URL.
- **Workers.** On the first `convertAt` the bundle probes once with a `blob:` worker that just answers. If
  the probe does not answer cleanly within 1.5 s, the one worker the bundle owns runs **on the main thread**:
  **PlayCanvas's gsplat sort worker** runs in-thread behind `workers.js` `mainThreadWorker()`. The build
  rewrites the engine's sorter so the worker function takes its dependencies as parameters —
  `(self, GSplatSortBinWeights)` — which is also what makes the REAL worker survive minification (the
  engine pastes the bin-weights class in by NAME, and the minifier renames the function's reference to
  it). No eval. The cost is main-thread time while orbiting, not correctness.
- **Output canvas**: this is the SDK's closed shadow root (`placement.js`).
- **Cross-origin media: NOT yet supported.** Patch 0222 exempts only WebGL `texImage2D` and
  WebGPU `importExternalTexture`. The SDK still reads the frame through `createImageBitmap` (and a 2D
  `drawImage` when `object-fit` crops), which stay tainted. Same-origin and CORS-clean media work. See
  [`tools/lift-builtin/BROWSER-SYNC.md`](../tools/lift-builtin/BROWSER-SYNC.md) §3.

## Build

```sh
npm run build:lift-builtin        # = node tools/lift-builtin/build.mjs   [--out dir] [--no-minify]
```

The SDK itself stays dependency-free. The build-only deps are pinned exactly in
`tools/lift-builtin/package.json` (with a lockfile) and installed there on the first run:
esbuild 0.28.2, playcanvas 2.22.3 (bundled from its ES-module source tree, `build/playcanvas/src`, so
esbuild keeps only what `js/lift/explore.js` names) and puppeteer-core (the manual GPU runners only).
The build **fails** if any source transform stops matching, for example after a playcanvas bump. Each
transform is a named string replacement in `build.mjs`.

Output in `lift-sdk/` (gitignored):

| file | size | gzip | brotli |
|---|---|---|---|
| `displayxr-lift-builtin.js` (+ `.map`, not staged) | 1.39 MB | 382 KB | 297 KB |
| `MANIFEST.json` | | | |

The bundle is 91 % PlayCanvas (the WebGL2 device, the scene/gsplat pipeline, the PLY parser — no WebGPU
backend: the device is constructed directly) and 9 % SDK. Before the P4 deletions it also carried the
ONNX Runtime siblings (16.5 MB of wasm) and the in-page converter.

`MANIFEST.json` (schema 2) holds `version`, `sdkVersion`, `commit`, `dirty`, the playcanvas/esbuild
pins and, per staged file, its `size`, `gzip`, `brotli` and `sha256`.

**Versioning.** The bundle version is `<package.json version>+<short commit>`, for example `1.24.0+58199a7`.
Build from a clean tree for anything that is staged. A `.dirty` suffix means the tree was not clean.

## Staging into the browser

`displayxr-browser-pvt` pins the bundle (`lift-sdk.pin`: url + sha256 + version, a release asset of that
repo) and `scripts/stage-lift-resources.sh` (run by `scripts/build.sh` and the Windows box's
`do_rebase.ps1`) copies `displayxr-lift-builtin.js` over the stub patch 0324 checks in.

## Test

`npm test` covers the SDK's pure parts (`test/lift-*.test.mjs`: the native module client, the state
machine, the chip, placement, explore orbit, SOG export, the built-in's decision rule). The GPU
runners (`test/lift-native.run.mjs`, `test/lift-explore-gpu.run.mjs`)
need a GPU browser and are run by hand.

The built-in's headless harness (`tools/lift-builtin/test/`: a fake scheme server, a strict-CSP page and
a puppeteer run through convertAt → explore → toggle) drove the in-page converter and was **removed with
it**. A replacement needs a fake runtime behind `displayxr-lift://caps` and `lift/gaussians`; until it
exists the built-in is exercised on the panel through the browser, and `test/lift-native.run.mjs`
covers `lift()` itself against a faked `window.fetch`.

What a harness cannot show: Chromium's world isolation (page script cannot reach `__dxrLift` in the
browser), the taint exemption, `isolated_world_origin` gating, and weaving.

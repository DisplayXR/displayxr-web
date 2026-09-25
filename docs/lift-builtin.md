# lift built-in — the DisplayXR Browser's "Convert to 3D" bundle

The DisplayXR Browser ships [`lift`](lift.md) as a **built-in**. The user right-clicks an image, a
video or a canvas and picks *Convert to 3D*. The browser (`displayxr-browser-pvt` patches 0220–0223)
then injects one classic script into a dedicated isolated world and calls it:

```js
globalThis.__dxrLiftNative = true;             // prologue, lift_trigger.cc
/* displayxr-lift-builtin.js */                // once per document
__dxrLift.convertAt(x, y, 'video');            // per pick; x, y = visual-viewport CSS px
```

This page covers how that script is built, what it needs at runtime, and how it is staged.
The source is in [`tools/lift-builtin/`](../tools/lift-builtin/).

## API

`globalThis.__dxrLift` is a frozen, non-enumerable, non-writable object:

| member | |
|---|---|
| `convertAt(x, y, mediaType)` → `Promise<{ok, reason?, action?}>` | Resolves the media under the point with the SDK's `resolveMediaAt`, after mapping visual-viewport px to client px (`visualViewport.offsetLeft/Top`, `/ scale`) and preferring an element of `mediaType` (`'image'`\|`'video'`\|`'canvas'`). It **refuses** with a reason when there is no media at the point, the video has `mediaKeys` (EME), or the image is not loaded. **Toggle**: if the element is already lifted, the lift is removed (`action:'removed'`). **One lift per document**: converting a second element removes the first, because ORT sessions must never be created concurrently (docs/lift.md). Calls are serialised. The promise never rejects. |
| `cancelAll()` | Removes every lift and restores the elements. |
| `status()` | Returns a plain-data snapshot for DevTools: version, ORT version, worker mode, and each lift's state and `stats`. It exposes no handles and no elements. |
| `version` | `<SDK version>+<short commit>` (a `.dirty` suffix marks an uncommitted tree). |

`lift(el, { models, ort, ui: 'builtin' })` does everything else: live 3D while a video plays, explore on
pause or for a still, and the chip with *Explore / Resume / Exit*.

## Browser hosting

**Runtime files** come from the pak as `displayxr-lift://runtime/<file>`. Anyone may request them.

| file | loaded how |
|---|---|
| `displayxr-lift-builtin.js` | not fetched: the browser reads it from the pak and runs it in the world |
| `ort.jspi.min.mjs` | `import()` by the bundle (the JSPI build, forced) |
| `ort-wasm-simd-threaded.jspi.mjs` | `import()` by the above, from `ort.env.wasm.wasmPaths` |
| `ort-wasm-simd-threaded.jspi.wasm` | `fetch()` by the glue (`application/wasm`) |

**Models** come from `displayxr-lift://models/<manifest name>`. The store answers **only `fetch()`/XHR
issued on the lift world's main thread**. Blink sets `isolated_world_origin` for nothing else, so a
worker's fetch, `import()`, `<script>` and `new Worker(url)` all get a 403. Hence:

- The model source is `createModelSource({ native: true, manifest })`, with the manifest compiled into the
  bundle. It `fetch()`es each model by name on the main thread and hands ORT a `Uint8Array`
  (`InferenceSession.create(bytes)`). It never gives ORT a URL.
- ORT is pinned to `numThreads = 1` and `proxy = false`. A threaded or proxied ORT would start a worker,
  which would be cross-origin to the page and could not reach the store.
- If the store refuses, `createModelSource` falls through to the public blob store over https
  (`connect-src https:` allows it). That is the documented last resort.

**The world's CSP** is `script-src 'self' displayxr-lift: 'wasm-unsafe-eval'; object-src 'none';
connect-src displayxr-lift: https:`. It has no `unsafe-eval`, no `data:` or `blob:` fetch, and no `blob:`
workers (`worker-src` falls back to `script-src`). The bundle is built for that:

- **No `import.meta` and no static `import`**: the build fails if either survives. The only `import()` left
  is ORT's runtime URL. `js/lift/providers/models.js`'s `import.meta.url` manifest default is rewritten
  to `displayxr-lift://runtime/models.json`.
- **`data:` wasm.** Spark loads its wasm from `data:` URLs. The bundle answers `data:` fetches locally, on
  the main thread and in its worker twins.
- **Workers.** On the first `convertAt` the bundle probes once with a blob worker that does what
  Spark's does: `fetch` of `data:` wasm, then `instantiate`. If the probe does not answer cleanly within 1.5 s,
  every worker the bundle owns runs **on the main thread**:
  - **Spark's sort/decode workers** get an in-thread twin. The build compiles Spark's worker source string
    into a function, so there is no eval at runtime. The real worker's blob is rebuilt from that same
    function with `Function.prototype.toString`, so only one copy of its wasm ships.
  - **lift-gen's PLY emit** uses lift-gen's own in-thread path (`worker:false`).
  - **ORT** is always worker-free (see above).

  Every path is therefore worker-free when it has to be. The cost is main-thread time (Spark's sort while
  orbiting, and the ~100–300 ms PLY emit), not correctness.
- **Output canvas**: this is the SDK's closed shadow root (`placement.js`).
- **Cross-origin media: NOT yet supported.** Patch 0222 exempts only WebGL `texImage2D` and
  WebGPU `importExternalTexture`. The SDK still reads source pixels through `createImageBitmap`, a 2D
  `drawImage`/`getImageData` and `copyExternalImageToTexture`, all of which stay tainted. Same-origin and
  CORS-clean media work. See [`tools/lift-builtin/BROWSER-SYNC.md`](../tools/lift-builtin/BROWSER-SYNC.md) §4.

## Build

```sh
npm run build:lift-builtin        # = node tools/lift-builtin/build.mjs   [--out dir] [--no-minify]
```

The SDK itself stays dependency-free. The build-only deps are pinned exactly in
`tools/lift-builtin/package.json` (with a lockfile) and installed there on the first run:
esbuild 0.28.2, three 0.180.0, @sparkjsdev/spark 2.1.0, onnxruntime-web
`1.31.0-dev.20260918-bc8e7ed75`, and puppeteer-core (test only). The build **fails** if the installed
onnxruntime-web differs from `ORT_VERSION` in `js/lift/providers/ort.js`, because the SDK's pin is the single source of truth.
It also fails if any source transform stops matching, for example after a Spark bump. Each transform is a named
string replacement in `build.mjs`.

Output in `lift-sdk/` (gitignored):

| file | size | gzip | brotli |
|---|---|---|---|
| `displayxr-lift-builtin.js` (+ `.map`, not staged) | 5.4 MB | 1.9 MB | 0.88 MB |
| `ort.jspi.min.mjs` | 65 KB | 20 KB | 18 KB |
| `ort-wasm-simd-threaded.jspi.mjs` | 50 KB | 18 KB | 16 KB |
| `ort-wasm-simd-threaded.jspi.wasm` | 16.2 MB | 4.0 MB | 2.6 MB |
| `MANIFEST.json` | | | |

The bundle is 85 % Spark, and most of that is its two base64 worker wasm blobs. three is 12 % and the SDK 3 %.
The pak brotli-compresses its resources, so the browser grows by about 3.5 MB.

`MANIFEST.json` holds `version`, `sdkVersion`, `commit`, `dirty`, the ORT/three/Spark/esbuild pins,
`modelsJson` (the sha256 and `generated` of the manifest compiled into the bundle), and per staged file its
`size`, `gzip`, `brotli` and `sha256`.

**Versioning.** The bundle version is `<package.json version>+<short commit>`, for example `1.21.1+f43d338`. Build
from a clean tree for anything that is staged. A `.dirty` suffix means the tree was not clean.

## Staging into the browser

In `displayxr-browser-pvt`, `scripts/stage-lift-resources.sh` (run by `scripts/build.sh` and the
Windows box's `do_rebase.ps1`) copies from `$DXR_LIFT_SDK_DIR` (default `<browser repo>/lift-sdk/`):
`displayxr-lift-builtin.js`, `ort.jspi.min.mjs`, `ort-wasm-simd-threaded.jspi.{mjs,wasm}`, plus
`installer/models.json`, over the stubs patch 0220 checks in. So either copy this repo's `lift-sdk/`
there, or point `DXR_LIFT_SDK_DIR` at it. `installer/models.json` must be byte-identical to
`js/lift/models.json` at the bundle's commit (`MANIFEST.json` `modelsJson.sha256`). BROWSER-SYNC.md §2
proposes the staging check for it.

## Test

```sh
npm run build:lift-builtin
node tools/lift-builtin/test/run.mjs [--csp strict|open|both] [--photo some.jpg] [--models ~/dxr-2d3d-exports/models]
```

`test/server.mjs` stands in for the scheme: `/runtime/<file>` serves `lift-sdk/`, and `/models/<name>` resolves the
**name** through `models.json` to `~/dxr-2d3d-exports/models/<path>`, like the store. The page loads the IIFE with a
`<script>`, which simulates the injection, after a harness that sets the test-only
`__dxrLiftConfig.schemeMap` (rewriting `displayxr-lift://` onto the server). The `strict` CSP is
`script-src 'self' 'wasm-unsafe-eval'; worker-src 'none'; connect-src 'self'`, which emulates the lift world: no workers,
no `data:` fetch. The `open` CSP allows `blob:` workers. `run.mjs` drives one headless Chrome (`--use-angle=metal
--enable-unsafe-webgpu`) through these steps for each mode, then writes PNGs and `report.json` to `test/_out/`:

1. video: `convertAt` → live
2. pause → explore, with a drag-orbit shot
3. `cancelAll`
4. image: `convertAt` → explore, with a drag-orbit shot
5. `convertAt` again → removed
6. an EME video → refused

Measured on an M1 Pro with Chrome 154, same-origin media, models from localhost through the native-store path:

| | strict (main-thread workers) | open (real workers) |
|---|---|---|
| bundle fetch / evaluate | 19 ms / 13 ms | 17 ms / 15 ms |
| video `convertAt` → live | 5.1 s (VDA model load 1.8 s, 75 ms/frame depth) | 5.1 s |
| pause → explore | 4.2 s (MoGe load + depth 1.5 s, generate 0.33 s, 0.79 M splats) | 4.8 s |
| image `convertAt` → explore (1.25 M splats) | 6.4 s | 6.3 s |
| explore fps (mono fallback) | 60 | 40–47 while dragging |
| API keys | `version, convertAt, cancelAll, status`, frozen | same |
| globals added | `__dxrLift` only (three/Spark leave nothing) | same |

Expected console noise:

- `strict` mode: the probe's `worker-src` violation (by design).
- Both modes: Spark's `new Function` probe (`script-src eval`, caught) and Spark's known `Worker terminate` rejection on dispose (docs/lift.md, Known issues).

What the harness cannot show:

- Chromium's world isolation. In the test the page and the bundle share one world, so `__dxrLift` is visible to the
  page. In the browser, page script cannot reach it at all.
- The taint exemption.
- `isolated_world_origin` gating.
- Weaving. The mock is the 2D fallback.

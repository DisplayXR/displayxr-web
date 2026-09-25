# Browser sync — what `displayxr-browser-pvt` needs from this bundle

Checked against `displayxr-browser-pvt` `feat/lift` @ `913d8e6`: patches 0220 (scheme and store), 0221
(menu and injection), 0222 (taint exemption), and `scripts/stage-lift-resources.sh`.
Do not edit the browser repo from here. Apply these there.

## 1. File names: no change needed

The bundle needs exactly the four files that patch 0220's pak table and `stage-lift-resources.sh`
already name:

| `displayxr-lift://runtime/…` | loaded by | how |
|---|---|---|
| `displayxr-lift-builtin.js` | `lift_trigger.cc` | read from the pak, run with `ExecuteJavaScriptInIsolatedWorld` (never fetched) |
| `ort.jspi.min.mjs` | the bundle | `import()` (`loadOrt({baseUrl:'displayxr-lift://runtime/', bundle:'jspi'})`) |
| `ort-wasm-simd-threaded.jspi.mjs` | `ort.jspi.min.mjs` | `import()` from `ort.env.wasm.wasmPaths` |
| `ort-wasm-simd-threaded.jspi.wasm` | the glue | `fetch()` + `instantiateStreaming` (needs `application/wasm`, which `MimeFor` sets) |

The bundle never requests `runtime/models.json`, because the manifest is compiled in. Keep serving it
anyway, since it documents what the store resolves. Nothing asks for `ort.webgpu.min.mjs` or the asyncify
files: the bundle forces the JSPI build (Chromium 154 ships JSPI) and pins `numThreads = 1` and
`proxy = false`, so ORT spawns no worker.

## 2. Proposed: tie the staged files to the build (`stage-lift-resources.sh`)

`lift-sdk/MANIFEST.json` records the sha256 of every staged file and of the `models.json` compiled
into the bundle (`modelsJson.sha256`). The bundle resolves models **by name** against its own copy,
so `installer/models.json` must be byte-identical to it. Today nothing checks that. Proposed diff:

```diff
@@ stage "$REPO/installer/models.json" models.json
+if [ -f "$SDK/MANIFEST.json" ] && [ -f "$REPO/installer/models.json" ]; then
+  want=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['modelsJson']['sha256'])" "$SDK/MANIFEST.json")
+  have=$(shasum -a 256 "$REPO/installer/models.json" | cut -d' ' -f1)
+  if [ "$want" != "$have" ]; then
+    echo "[lift] installer/models.json ($have) != the bundle's models.json ($want): re-sync the installer copy" >&2
+    [ "$CHECK" -eq 1 ] && exit 1
+  fi
+  echo "[lift] SDK bundle $(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['version'])" "$SDK/MANIFEST.json")"
+fi
```

## 3. The lift world's CSP: no change required, one option

`kWorldCsp` is `script-src 'self' displayxr-lift: 'wasm-unsafe-eval'; object-src 'none'; connect-src
displayxr-lift: https:`. What the bundle does under it:

- **`data:` wasm.** Nothing to answer any more: the explore renderer is the PlayCanvas engine (plain-JS
  sort worker, no wasm). Until 2026-09 Spark fetched `data:` wasm and the bundle answered it locally.
- **Workers.** With no `worker-src`, the policy falls back to `script-src`, so `blob:` workers are blocked. The bundle probes
  once (`probeWorkers`) and runs every worker it owns **on the main thread**: PlayCanvas's gsplat sort worker runs the
  same function in-thread (passed in at build time, no eval), and lift-gen's PLY emit uses its in-thread path. This was
  measured in `tools/lift-builtin/test` with `worker-src 'none'` (see docs/lift-builtin.md).
- **`eval`.** Nothing in the bundle probes `eval` / `new Function` any more (that was Spark).
- **Option.** Adding `worker-src blob:` would let the probe pick the real sort worker, which keeps the sort off the main
  thread during orbit. This only matters on weak CPUs, and it is unverified whether a `blob:` URL minted in an isolated
  world may start a worker for the page's origin. Leave it off until measured on the panel.

## 4. Blocker outside this bundle: cross-origin media readback (0222 vs the SDK)

Patch 0222 exempts **only** WebGL `texImage2D(img|video|canvas)` and WebGPU `importExternalTexture`.
The SDK currently reads the source pixels through the **non-exempt** paths as well:

| where | call | when |
|---|---|---|
| `js/lift/lift.js:290-302` | 2D `drawImage` into a crop canvas | `object-fit` crops (`cover`, `none`) |
| `js/lift/lift.js:517` | `createImageBitmap(source)` | every freeze (the frame that gets lifted) |
| `js/lift/providers/preprocess.js:110` | `copyExternalImageToTexture` | the GPU preprocessor (every depth inference) |
| `js/lift/providers/preprocess.js:35-36` | 2D `drawImage` + `getImageData` | the CPU preprocessor fallback |
| `js/lift/gen/lift-gen.js:124-141` | `createImageBitmap` / 2D `drawImage` + `getImageData` | the generator's RGB raster |

Same-origin and CORS-clean media work, and the test harness uses those. Cross-origin media such as YouTube or
most CDN images will throw `SecurityError` at the first of these calls, and `convertAt` will then report a fatal
lift error. The fix must go on one side or the other: move the SDK onto `importExternalTexture` or WebGL
`texImage2D`, with readback of the *model-resolution* tensor only, or widen 0222. The second option is a
security decision, because an exempt `createImageBitmap` hands the lift world a clean bitmap. The SDK side is the
recommended fix. It is not in this bundle's scope.

## 5. Unverified until the first box build

- `import()` from an embedder isolated world. It works in extension content scripts, but it has not been checked here.
  If it fails, `convertAt` resolves `{ok:false, reason:'ort-load-failed: …'}`. The fallback would be to
  inline `ort.jspi.bundle.min.mjs`, which still needs the `.wasm` sibling.
- The model `fetch()` 200 from the lift world. This is 0220's `isolated_world_origin` gate. The bundle's model
  fetches are main-thread `fetch()` calls by manifest name (`createModelSource({native:true})`), and
  ORT receives bytes, never a URL.

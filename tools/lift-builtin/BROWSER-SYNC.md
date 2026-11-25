# Browser sync — what `displayxr-browser-pvt` needs from this bundle

Updated for the ADR-053 P4 deletions. Do not edit the browser repo from here; apply these there.

## 1. File names

The bundle needs exactly one file from the pak, which patch 0324's table and
`stage-lift-resources.sh` already name:

| `displayxr-lift://runtime/…` | loaded by | how |
|---|---|---|
| `displayxr-lift-builtin.js` | `lift_trigger.cc` | read from the pak, run with `ExecuteJavaScriptInIsolatedWorld` (never fetched) |

The ONNX Runtime files (`ort*.mjs`, `ort*.wasm`) and `models.json` are no longer produced. The browser
must stop packing, staging and serving them, and must stop serving `displayxr-lift://models/` and
`status/` (the P4-3 patch). `MANIFEST.json` is schema 2: it has no `ort` and no `modelsJson`, so
`fetch-lift-sdk.sh`'s `installer/models.json` check goes with them.

## 2. The lift world's CSP: no change required, one option

`kWorldCsp` is `script-src 'self' displayxr-lift: 'wasm-unsafe-eval'; object-src 'none'; connect-src
displayxr-lift: https:`. What the bundle does under it:

- **Wasm.** None. The explore renderer is the PlayCanvas engine (a plain-JS sort worker). `'wasm-unsafe-eval'`
  can be dropped from the CSP once nothing else in the world needs it.
- **Workers.** With no `worker-src`, the policy falls back to `script-src`, so `blob:` workers are blocked. The bundle
  probes once (`probeWorkers`) and runs its one worker (PlayCanvas's gsplat sort) **on the main thread**: the same
  function in-thread, passed in at build time, no eval.
- **Option.** Adding `worker-src blob:` would let the probe pick the real sort worker, which keeps the sort off the main
  thread during orbit. Unverified whether a `blob:` URL minted in an isolated world may start a worker for the page's
  origin. Leave it off until measured on the panel.

## 3. Blocker outside this bundle: cross-origin media readback (0222 vs the SDK)

Patch 0222 exempts **only** WebGL `texImage2D(img|video|canvas)` and WebGPU `importExternalTexture`.
The SDK still reads the source pixels through non-exempt paths:

| where | call | when |
|---|---|---|
| `js/lift/lift.js` (`currentSource`) | 2D `drawImage` into a crop canvas | `object-fit` crops (`cover`, `none`) |
| `js/lift/lift.js` (`doFreeze`) | `createImageBitmap(source)` | every freeze (the frame that gets lifted) |

Same-origin and CORS-clean media work. Cross-origin media such as YouTube or most CDN images will throw
`SecurityError` at the first of these calls, and the lift reports an error. The fix is on one side or the other:
snapshot the frame on the browser side (the runtime's lift stream already does this for live conversion; a still
or a paused frame would go through the same GPU-side snapshot, which is what keeps 0326 alive until it exists), or
widen 0222. The second option is a security decision, because an exempt `createImageBitmap` hands the lift world a
clean bitmap.

## 4. Unverified until the first box build

- The lift world's `GET displayxr-lift://caps` / `POST lift/gaussians` from the bundle: these are main-world-gated by
  `isolated_world_origin` exactly as before.

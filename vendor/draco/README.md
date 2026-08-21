# Draco decoder — vendored for the samples

These are three.js's copies of the Draco decoder runtime, taken verbatim from
`three@0.180.0/examples/jsm/libs/draco/`:

| file | why |
|---|---|
| `draco_wasm_wrapper.js` | the JS half `DRACOLoader` loads first |
| `draco_decoder.wasm` | the wasm decoder it instantiates |

`draco_decoder.js` (the ~800 kB asm.js fallback for browsers without WebAssembly) is deliberately
**not** vendored — every browser that can run inline-3D has wasm. Copy it too if you need that
fallback.

They are here because [`samples/model/`](../../samples/model/) loads a Draco-compressed glTF, and
`@displayxr/inline3d/model` will not fetch a decoder from a CDN on your behalf: an offline build
must not acquire a network dependency from one asset's compression setting. The sample points
`decoderPath` at this directory. In your own site, do the same thing with your own copy —
`cp -r node_modules/three/examples/jsm/libs/draco/ public/draco/`.

See [`docs/authoring-inline-3d.md#compressed-gltf`](../../docs/authoring-inline-3d.md).

Draco is © The Draco Authors, licensed Apache-2.0 — the same license as this repository.

# The PlayCanvas backend for `addModel` — the default from 1.12

Status: **shipped (1.12.0, preview tier).** Epic [#36](https://github.com/DisplayXR/displayxr-web/issues/36).
`addModel(wall, canvas, src)` renders with the [PlayCanvas](https://playcanvas.com/) engine by
default; `engine: 'three'` is the 1.11 three.js renderer, unchanged (also importable directly as
`@displayxr/inline3d/model/three`). This note says what was built, how its lighting was matched,
what was measured, and what throws. The splat side of the same engine is
[playcanvas-adapter.md](playcanvas-adapter.md).

## Why the default moved

- **PlayCanvas is the better-optimised engine for this SDK** (David, 2026-09-24): it already
  carries the splat path (≥3.5× faster in stereo), renders every view of a tile through ONE camera
  with N `RenderView`s, and is 1.6–2.2× faster than three once shadows are involved (the mesh
  bench, #36). Without shadows the two tie, and both are an order of magnitude under budget.
- **One engine per page.** A catalogue that mixes captured splats and vendor meshes now loads one
  engine, and a model tile can hold a splat (and vice versa) through `handle.engine`.
- **A reference that is not an engine.** Moving engines was the moment to stop treating either
  engine's look as correct. The lighting reference is the Khronos glTF Sample Viewer (below).

## Shape

```
./model  →  js/inline3d-model-entry.js        (router; no engine import of its own)
             ├── engine unset / 'playcanvas' → import('./inline3d-model-playcanvas.js')
             │                                  + import('./inline3d-playcanvas-engine.js') → playcanvas
             └── engine 'three'              → import('./inline3d-model.js')  (1.11, byte for byte)
```

- **The handle is returned synchronously on both engines.** Calls made before the backend lands
  (`exclude()` on the next line above all, `setPose`, `resetPose`, `remove`, `setCameraPose`) are
  queued and replayed on the same object; `ready` resolves to it. `viewer` is null until the
  backend module has loaded — that is the one handle difference from 1.11, and the reason
  `./model/three` exists.
- **The tile host is the splat adapter's**, reused as is: `PlayCanvasSplatViewer` (one `AppBase`
  per tile on our own WebGL2 device, no XR, no input; one eye camera with N `RenderView`s; the rig
  node carries the inverse pivot so the eyes move and the model stays put; fit/margin/fitSweep/
  depthLimit, tilt-and-relax orbit, idle spin, zoom, `feather`, `renderScale`, the mono loop,
  validate-before-clear and last-good replay). Three knobs were added to it: `toneMapping` (by
  name; splats keep `none`), `antialias` on `attachEngine` (splats keep it off) and
  `patchSplats: false` (a model tile skips the gsplat chunk patches).
- **Loading**: the asset is fetched once and its glTF JSON read for `extensionsUsed` (exactly as on
  three), then handed to the engine as `pc.Asset(…, 'container', { url, contents })` — no second
  fetch — and `instantiateRenderEntity()` goes under the content root. `handle.model` is that
  entity, `handle.container` the resource (animations, materials, textures). No animation plays,
  as on three; a page animates through `handle.engine` (the `Anim` system is registered).
- **Framing** is the union of the render mesh instances' AABBs. It equals three's `Box3` to float
  precision on every asset tried, skinned ones included (Fox 25.185 × 79.029 × 154.720 on both), so
  the fit scale matches three's to 1e-9.

## Decoders — the same served files as three

| glTF extension | PlayCanvas reader | files your page serves (unchanged) |
|---|---|---|
| `KHR_draco_mesh_compression` | the engine's Draco worker (`dracoInitialize`) | three's `libs/draco/` → `/draco/` (`draco_wasm_wrapper.js`, `draco_decoder.wasm`) |
| `KHR_texture_basisu` | the engine's Basis worker (`basisInitialize`) | three's `libs/basis/` → `/basis/` (`basis_transcoder.js`, `.wasm`) |
| `EXT_meshopt_compression` | meshoptimizer's `MeshoptDecoder` through the container's `bufferView.processAsync` hook (the engine has no meshopt reader in 2.22.3) | none — `meshoptimizer/decoder` (optional peer `meshoptimizer >=1`) |

- The engine's workers accept three's files as they are: Draco's wasm wrapper is Google's, and the
  Basis glue is the Binomial transcoder the engine's worker expects (`BASIS()` → `KTX2File`).
  Verified headless: the Draco Duck and the KTX2 FlightHelmet load and texture on both engines.
- Only the decoders an asset declares are wired; an uncompressed asset fetches nothing else.
- The files are **pre-flighted** (one GET each, cached): a mis-served folder rejects `ready` with an
  Error naming the extension, the missing file, `decoderPath` and the folder to copy
  (`err.gltfExtension`, `err.decoder`) — the engine would otherwise log a worker error and resolve
  a model with no textures.
- **One pool per page.** The engine's Draco and Basis readers are module-level: the first tile
  that needs one sets its path, and a later tile asking for another path is warned and decodes
  with the first. (three builds one per configuration.)
- `DRACOLoader`, `KTX2Loader` and `GLTFLoader` are three objects: with `engine: 'playcanvas'` they
  throw; with no `engine` they select three (so a 1.11 page that injects them keeps working).

## Lighting — matched to the Khronos glTF Sample Viewer

**Reference.** The Khronos glTF Sample Viewer renderer (`@khronosgroup/gltf-viewer` 1.1.0,
headless Chrome, ANGLE Metal on M1 Pro) with its "Studio Neutral" environment
(glTF-Sample-Environments `low_resolution_hdrs/neutral.hdr`, 1024×512), Khronos PBR Neutral tone
mapping, exposure 1, IBL intensity 1, `environmentRotation` 90 (its default), no punctual lights
added, no background, MSAA on, 512×512, camera = the SDK's own mono camera expressed in model space
(35° vertical, on the +Z axis through the bounds centre at the fit distance). Neither engine is the
reference.

**What the PlayCanvas default does to match it.**

| | PlayCanvas default (1.12; `environment: 'neutral'`) | three (1.11, unchanged) |
|---|---|---|
| environment | in-memory neutral studio → `EnvLighting` → `scene.envAtlas` | RoomEnvironment → PMREM |
| tone mapping | `TONEMAP_NEUTRAL` (Khronos PBR Neutral) | none |
| exposure | 1 | 1 |
| output | sRGB (`GAMMA_SRGB`) | sRGB |
| background | none (sky layer off; transparent canvas) | none |
| MSAA | on | on |

**The environment is generated, not shipped.** `neutralStudioRGBE()` fills a 256×128 RGBE equirect
from a floor-to-ceiling radiance profile (10 values) plus 18 spherical-Gaussian lobes, and the
engine prefilters it into an envAtlas at load. The numbers were fitted by solid-angle-weighted
least squares to Studio Neutral (RMS 0.30 on a 64×32 grid, mean radiance 0.892 vs 0.895, SH9
irradiance error 2.0%). The image is ours — a few dozen fitted numbers, not a copy of the HDRI —
so the package carries **no asset and no attribution requirement** (Studio Neutral itself is
CC-BY-4.0, Amazon; it is used only as the comparison target, never bundled). Cost: ~20 ms to
generate once per page (cached for every later tile; measured in Node) and one engine prefilter
pass per tile.

**Orientation** was calibrated, not assumed: a sweep over yaw 0/90/180/270 × mirrored, then
±15°/±30°, has a clean minimum at yaw 0 on all four models (`ENV_YAW_DEG`). `environmentRotation`
(degrees) turns it per tile.

**Result** — MAE vs the Sample Viewer, /255, 512×512, rest pose, no animation. "Object" is the union
of the reference's and the engine's coverage masks (from a black and a magenta background).

| model | PlayCanvas default: object | full frame | three default: object | full frame | silhouette IoU vs reference |
|---|---|---|---|---|---|
| DamagedHelmet | **16.7** | 3.41 | 36.2 | 7.37 | 0.9986 |
| Fox (skinned) | **6.4** | 0.31 | 19.5 | 0.91 | 0.9956 |
| BrainStem (skinned, 59 draws) | **2.7** | 0.27 | 26.7 | 2.64 | 0.9900 |
| MetalRoughSpheres | **9.4** | 2.85 | 26.4 | 7.97 | 0.9887 |

Gate — *the PlayCanvas default is at least as close to the reference as three on every model* —
passes on all four, by 2.2–10×. The residual on the helmet is the mirror-like visor reflecting a
smooth fitted studio instead of the photographed one (mean on-object 94 vs the reference's 103).
The silhouette IoU is below 1 by MSAA edge pixels and the Sample Viewer's own bounds handling; it is
identical for both engines.

`environment: 'room'` is three's room on this engine — [§ Environments](#environments--neutral-default-and-room-three).
`environment: 'studio'` maps three's three-point rig onto directional lights (intensity ÷ π, since
the engine's BRDF has no Lambert 1/π; aimed by rotation because engine lights shine along −Y) and
three's hemisphere light onto `scene.ambientLight`. It is not tuned against anything; it exists so
`samples/shopify` and pages that chose it keep a punctual look.

## Environments — `neutral` (default) and `room` (three)

| `environment` | PlayCanvas | tone mapping | three (`engine: 'three'`) |
|---|---|---|---|
| `neutral` — **default** | generated neutral studio, fitted to the Sample Viewer's Studio Neutral (above) | Khronos PBR Neutral | — |
| `room` | three's RoomEnvironment, regenerated in memory (below) | **none** (three's) | RoomEnvironment → PMREM (default) |
| `studio` | three's three-point rig as directional lights | Khronos PBR Neutral | three-point rig |
| `none` | nothing | Khronos PBR Neutral | nothing |

`handle.setRig('display', { environment })` on a splat tile takes `neutral` (default), `room` and
`none` with the same meaning, and the same tone mapping unless `toneMapping` is passed
([adapter § setRig](playcanvas-adapter.md#setrig--switching-between-the-display-rig-and-the-camera-rig-36)).
**Through 1.16 `room` was an alias of `neutral` on this engine**, so a page that passed
`environment: 'room'` to keep its three look silently got the Sample-Viewer studio and PBR Neutral
tone mapping. The default did not move.

**Why `room` exists.** The Sample Viewer, not three, is the reference for the default (above), and
that stays. But a page tuned on the three path chose three's room, and on a real catalogue (the Show
app's storm lantern, handbag, boot, compass) that choice, not an engine difference, was most of
the gap. Object MAE (/255, 512², rest pose, mono) of each PlayCanvas render against three r180 with
`environment: 'room'`, factor by factor:

| step (cumulative) | lantern | handbag | boot | compass |
|---|---|---|---|---|
| PlayCanvas default (neutral studio + PBR Neutral) | 20.5 | 54.4 | 29.5 | 23.3 |
| + tone mapping none | 15.1 | 40.4 | 14.1 | 12.8 |
| + three's own RoomEnvironment (its PMREM read back, `yaw 90`) | 11.9 | 12.8 | 7.4 | 6.4 |
| + transmission fixes ([below](#transmission-khr_materials_transmission--volume)) | 10.2 | 12.8 | 7.4 | 6.4 |
| + three's 0.04-rad blur | 10.2 | 11.2 | 6.9 | 6.2 |
| **`environment: 'room'` as shipped** (the generated room) | **10.2** | **11.0** | **7.1** | **6.3** |

Split with both orders (Shapley over the two big factors): tone mapping accounts for 7.4 / 11.6 /
13.4 / 11.5 of the gap and the environment for 1.2 / 29.9 / 8.7 / 5.5 — the handbag's "less glossy
highlights" is mostly the environment (three's room has a 100-nit ceiling panel and two 50-nit
wall panels; the neutral studio's brightest lobe is far softer). Neither engine adds a punctual
light for `room`, both write sRGB, and env intensity 0.9 / 1.1 is worse than 1 on three of four
items, so none of those is a factor.

**What is left is three, not this engine.** Rendering the same four assets in the Sample Viewer
with three's room as its environment (exported from three's own PMREM, tone mapping NONE, rotation
calibrated) and comparing both engines to THAT:

| vs Sample Viewer + room | lantern | handbag | boot | compass |
|---|---|---|---|---|
| three `room` | 11.8 | 13.4 | 8.3 | 8.5 |
| PlayCanvas `room` | **10.6** | **4.8** | **4.7** | **5.7** |

The residual against three is where three departs from the reference (its handbag reads glossier
than the Sample Viewer's), so it was not chased.

**How the room is made.** `ROOM_ENVIRONMENT` holds the scene numbers of three's
`RoomEnvironment.js` (MIT — see `THIRD_PARTY_NOTICES.md`): a white room lit by one point light,
six grey boxes, six emissive panels. `roomRadiance(dir)` ray-casts it from the origin and shades a
hit the way three shades it when it bakes the PMREM — the panel's emissive value, or Lambert + GGX
at roughness 1 from the point light with three's falloff window, no shadows. `roomEquirect()` fills
a 256×128 equirect and applies three's 0.04-rad blur; it is RGBE-encoded and prefiltered by the
engine like the neutral studio. Against three r180's own bake (its PMREM read back through
`textureCubeUV`), texel ratio median 1.000 (p10 0.989, p90 1.006), solid-angle-weighted MAE 0.04.
Cost: ~16 ms once per page (cached), then the engine prefilter per tile. **Orientation**:
`ROOM_YAW_DEG = 90`, from a 0/90/180/270 × mirrored sweep with a clean minimum at 90 unmirrored on
two assets.

## Transmission (`KHR_materials_transmission` / `_volume`)

The engine reads both into `useDynamicRefraction` + `BLEND_NORMAL`: the material samples the
camera's scene-colour map. Three things are the app's job, and the backend now does them for every
transmissive draw (`prepareTransmission`), on the default too; `setRig('display')` does the same for
meshes under root:

1. **The grab pass.** No camera rendered the scene-colour map, so the material sampled an unbound
   texture: the storm lantern's burner rendered as a **magenta** blob inside its globe.
   `viewer.useSceneColor()` turns it on for every eye camera, only when a transmissive draw exists.
2. **Pass order.** The Sample Viewer and three draw opaque → transmissive → blended. The engine sorts
   transmissive and blended draws in one back-to-front list, so the lantern's blended globe
   (depthWrite off) was drawn first and the transmissive body painted over it; the burner showed
   through an opaque-alpha globe. Transmissive draws now sort ahead of blended ones.
3. **Stereo.** The engine maps the refracted point's view NDC over the whole render target
   (`getGrabScreenPos`). A stereo tile draws two views side by side, so each eye sampled across
   both. A patched `refractionDynamicPS` takes the offset from the fragment itself (NDC delta ÷
   NDC-per-pixel, from derivatives): identical in mono (max 1/255), and left/right consistency on a
   refractive plane goes from MAE 3.5 to 0.4 (the unpatched right eye shows a squashed copy of the
   whole frame).

Lantern object MAE: vs three `room` 11.9 → 10.2; vs the Sample Viewer, default 14.4 → 12.4 and room
11.5 → 10.6. The four Khronos gate models carry no transmission, so the default's table above is
unchanged (re-run: 16.7 / 6.4 / 2.7 / 9.4).

Not done: three renders a double-sided BLENDED material in two passes (back faces, then front);
the Sample Viewer and this engine draw it once. Two passes would bring the lantern's globe closer
to three (glass alone 12.5 → 7.4) but move it away from the Sample Viewer, so it was left alone.

## What throws, at call time

- `engine` other than `'playcanvas'` / `'three'`; `environment` other than `room` / `neutral` /
  `studio` / `none` (PlayCanvas); `envMap` not a string or object.
- A PlayCanvas-only option (`playcanvas`, `environmentRotation`, `controls`, `comfortDepth`,
  `onBeforeFrame`, `antialias`, `preserveDrawingBuffer`, `nearClip`, `farClip`, `orbitMaxDeg`,
  `orbitEase`) with an explicit `engine: 'three'`.
- A three.js object (`GLTFLoader`, `DRACOLoader`, `KTX2Loader`, a three texture as `envMap`) with an
  explicit `engine: 'playcanvas'`.
- `meshoptDecoder` without `decodeGltfBuffer`; `controls` other than `viewer` / `page`;
  `onBeforeFrame` without `controls: 'page'`; a bad `canvas` or `src`.
- On the handle: `setCameraPose` without `controls: 'page'`; `setPose` / `resetPose` with it; a
  malformed pose (non-finite matrix, bad fov/near/far/convergence).
- Through `ready` (not thrown): an HTTP error on the asset; a needed decoder unavailable; `playcanvas`
  unresolvable with an explicit engine (with no engine: falls back to three with one warning, or
  rejects naming both installs when three is missing too).

## Size and speed

**Bundle** (esbuild 0.28.2 `--bundle --splitting --minify`, gzip -9):

| engine chunk | minified | gzip |
|---|---|---|
| `import('playcanvas')` namespace (1.11 splat adapter) | 2,434,536 | 626 KB |
| named re-exports, `js/inline3d-playcanvas-engine.js` (1.12, both adapters) | 1,499,851 | **397 KB** |

The default model page's SDK chunks on top of the engine: 15.5 KB gzip (the backend + the shared
viewer) + 8.5 KB (router and shared helpers). three is not in the graph.

**Speed** (M1 Pro, headless Chrome, uncapped, 2-view 3840×1080 double-width buffer, MSAA on both,
ms per frame, median of 10 batches, 2 runs agree within 3%):

| asset | PlayCanvas, 30 frames + 1 readPixels | three, same | PlayCanvas, readPixels every frame | three, same |
|---|---|---|---|---|
| DamagedHelmet | 1.36 | 0.68 | 1.35 | 2.2 |
| Sponza (262k tris) | 2.06 | 1.5–1.7 | 2.07 | 4.9–5.5 |

The two methods disagree in opposite directions and neither is the displayed-frame cost. With MSAA,
PlayCanvas renders into its own multisampled back buffer and resolves it at the end of every
`app.tick()` (−0.8 ms at this size with `antialias: false`: 0.58 ms), while three renders into the
default framebuffer, whose resolve the browser defers to the next read or composite — amortised
across a 30-frame batch, paid every frame when each frame is read. At one displayed frame per
vsync both pay one resolve. Everything is under 3 ms at 3840×1080 against a 16.7 ms budget; the
mesh bench's no-MSAA throughput (0.54 vs 0.59 ms on the Helmet) is the like-for-like engine number.

## Gates (run for 1.12.0)

- `npm test`: 331 pass (23 new in `test/model-playcanvas.test.mjs`: routing and fallback,
  call-time validation, the synchronous handle and its queue, engine defaults, studio light aim,
  framing, decoder wiring and errors, the meshopt hook, `controls:'page'`, the named-import
  module covering every engine member both adapters read).
- Headless real GPU, both engines, 0 console errors (a favicon 404 aside): DamagedHelmet, Fox,
  BrainStem, MetalRoughSpheres, Draco Duck, meshopt BrainStem (`EXT_meshopt_compression` +
  `KHR_mesh_quantization`), KTX2 FlightHelmet, Sponza, the sample Fox. Framing bounds and fit scale
  equal between engines to 1e-6.
- 2-view off-axis: two views with the same pose and ±0.1 NDC skew → the right eye is the left
  shifted by exactly 64 px (MAE 0.0 at the best shift) on the Helmet and the Fox.
- Netcheck: `samples/shopify/` on the default requests no `three`; with `?engine=three` it requests
  no `playcanvas`.
- `samples/model/` and `samples/shopify/` load on both engines with every tile's note resolved.

## Divergences from the three path, kept on purpose

- The look (above). `engine: 'three'` is the kill switch.
- `handle.model` is a `pc.Entity`; `handle.viewer` is the PlayCanvas viewer (the SceneViewer pose
  surface, not its fields: no `scene`, `renderer`, `content` as three objects).
- The orbit is tilt-and-relax (the splat adapter's), not SceneViewer's cumulative turntable drag.
- One Draco / Basis pool per page (above).
- `KHR_materials_transmission` still differs between the engines in detail (three draws a
  double-sided blended material in two passes, § Transmission).

## NOT TESTED

- `environment: 'room'` on the real DisplayXR Browser weave, and on assets beyond the four catalogue
  items (the calibration is two assets for orientation, four for the table).
- `KHR_materials_volume` with a thickness on real assets (the stereo grab UV was checked on a
  synthetic plane at thickness 0 and 0.3); `KHR_materials_dispersion` (three extra grab samples,
  same patched function).
- setRig's transmission check on a page that adds a transmissive mesh while the splat is SHOWN.

- The real DisplayXR Browser weave (views came from a fake wall), Windows/D3D11 ANGLE, Android.
- Multi-tile pages beyond the model sample's three tiles; memory and GPU residency over a long
  session; a cold shader cache.
- `envMap` as a URL or a `pc.Texture` on real assets (wired, unit-tested with a fake engine only).
- `controls: 'page'` on a real page (unit-tested only).
- The fallback-to-three path in a browser with `playcanvas` unmapped (unit-tested for "neither").
- Animation playback through `handle.engine`; skinned framing after an animation has moved the skin.
- Bundlers other than esbuild (webpack, Vite, Turbopack) for the named-import module.
- A capped (vsync) frame-time comparison; the numbers above are throughput.

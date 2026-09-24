# Splat effects (`engine: 'playcanvas'`)

**Preview tier** ([`sdk-stability.md`](sdk-stability.md)): `./splat` on the PlayCanvas backend.
Spark throws on every entry point below ("PlayCanvas-only in this version"). The Spark ports are
a follow-up.

These are GPU effects on the splats themselves. Examples: a photo inflating into depth when it
loads, a sweep that dissolves it in, a colour grade, a clip box, a transition between two photos,
or your own GLSL. They run in the engine's per-splat vertex stage, so every view of a woven tile
draws the same thing.

```js
import { addSplat } from '@displayxr/inline3d/splat';

const h = addSplat(wall, canvas, 'photo.sog', { engine: 'playcanvas', reveal: 'inflate' });

await h.playEffect('pulse', { origin: 'focus' });         // a one-off ring of light
h.setEffect('grade', { saturation: 0.6, exposure: 0.3 }); // persistent until removed
h.setEffect('grade', null);                               // gone: the exact baseline
await h.setSource('next.sog', { transition: 'wavefront' }); // photo → photo
```

## The one rule: world position and time only

Each eye of a woven tile renders the same splats from a slightly different place. An effect that
decides something from a screen position (`gl_FragCoord`, the view matrix, the viewport) decides
differently in each eye, and the viewer sees rivalry. Every effect here is keyed on the splat's
WORLD position and on time. The custom hook refuses GLSL that reads a screen-space input.

Measured: with the two views at the same position (fake stereo, `sep 0`, `skew 0`), the left and
right eye are identical, MAE 0.000, for every effect at every progress, in both scopes.

## API

| Call | What |
|---|---|
| `addSplat(…, { reveal })` | `'inflate' \| 'sweep' \| 'dissolve' \| 'fade' \| false \| { type, durationMs, holdMs, easing, origin, …params }`. The effect is installed at its start state before the asset's first frame. It plays once `handle.firstWoven` settles (at once in 2D) and the first two frames have built. |
| `handle.playEffect(name, opts) → Promise<{ finished }>` | A timed effect: `inflate`, `deflate`, `sweep`, `dissolve`, `fade`, `pulse`, `custom[:name]`. It is validated at the call and runs once the first asset is on screen. `finished` is false when the effect was stopped or replaced. |
| `handle.setEffect(name, params \| null)` | A persistent effect (`grade`, `clip`, `custom`), or any timed effect held at `{ progress }` (0..1). Useful for scroll-driven looks and for tests. `null` removes it. |
| `handle.stopEffect(name?, { finish })` | Removes the named effect, or all effects when no name is given. This restores the baseline exactly. With `finish: true` the effect jumps to its end state instead: an `in` effect is removed, an `out` effect holds its end state. |
| `handle.effects()` | `[{ name, scope, stage, playing, waiting, progress }]`. |
| `handle.setSource(src, { transition, durationMs, easing, reveal, fadeMs, resetPose })` | Swap the asset. See [Transitions between assets](#transitions-between-assets). |

Options that every timed effect takes:

- `durationMs`
- `holdMs`: time held at the start state before the clock runs.
- `easing`: `linear`, `easeIn/Out/InOut` × `Quad`/`Cubic`, `easeInOutSine`, or a function.
- `origin`
- `direction`: `'in'` (the default) arrives and is removed at the end. `'out'` leaves, and its end state is held until you stop it.
- `scope`: see below.

**Origins** can be:

- `'focus'`: the focus point.
- `'eyes'`: the midpoint of the eyes that drew the last frame, or the mono camera in 2D.
- `[x, y, z]`: a point in the splat's own space, as `setFocus` takes it.
- A canvas point, `[clientX, clientY]` or `{ clientX, clientY }`. It becomes a world point through `pick()` when the effect starts.

**Scope.**

- `'tile'` (the default): the effect goes into the unified render material's `gsplatModifyVS` chunk. It runs for every splat of the tile, at render time, and costs nothing extra (see Gates).
- `'entity'`: the effect is a work-buffer modifier on the current asset only. `setSource` uses this scope to reveal the incoming asset and leave the outgoing one alone. While an entity effect is on, the asset's work buffer is re-rendered every frame. That measured as no slower, and in stereo faster (see Gates).

### One generated chunk, fixed order

The SDK owns the chunk. Every active effect of a scope is one GLSL body with its own uniform
prefix (`dxrFx_<name>_`). The chunk calls those bodies in a fixed order, whatever order the calls
came in: **grade → clip → reveal → pulse → custom**. When the last effect of a scope is removed,
the SDK deletes the chunk for a tile, or the modifier for an entity. The engine then uses its own
default again, so the result is the baseline exactly, not a no-op look-alike.

## Effects

| Effect | Kind | What it does | Parameters (defaults) |
|---|---|---|---|
| `inflate` | reveal | The gallery's Spatial View reveal. Each splat moves along its ray from the origin (the eyes by default) to `z' = D + (z − D)·s`, with `s` going from `residual` to 1. Centre and scale both scale by the same λ. From the origin nothing moves; the eyes see disparity arrive. | 1200 ms, `easeOutCubic`, origin `'eyes'`, `residual` 0.05 |
| `deflate` | reveal, out | `inflate` in reverse: the splat flattens onto its convergence plane (zero disparity) and stays flat. | 1200 ms, `easeInOutSine` |
| `sweep` | reveal | A radial dissolve-in from a point. The front is jittered, its radius reaches the farthest corner of the FRAMING box (not the raw bound), and splats grow in from dots behind a tinted band. No splat moves. | 1500 ms, `easeInQuad`, origin `'focus'`, `band` 0.1, `edgeColor` [0.2, 0.9, 1], `edge` 0.6 |
| `fade` | reveal | Opacity with a coverage-linear remap, `α' = 1 − (1 − α)^k`. Scaling alpha by t saturates on a dense photo. Measured coverage is linear to ±8 % on three SHARP photos. | 800 ms, `linear` |
| `dissolve` | reveal | The engine's dissolve script, inverted into a reveal. Splats burn in along an fbm noise front, rise along the camera's UP, sway, and glow at the edge. Sizes follow the framing box. | 2000 ms, `noiseScale` 3, `edgeWidth` 0.12, `edgeColor` [1, 0.45, 0.1], `lift` 0.25, `wave` 0.03 |
| `pulse` | pulse | A ring of light expands from a point and fades. Colour only. | 1200 ms, `easeOutQuad`, origin `'focus'`, `color` [1, 1, 1], `strength` 0.35, `band` 0.06, `radius` (farthest framed corner) |
| `grade` | persistent | Exposure (stops), contrast, saturation, and a tint multiplier. | 0, 1, 1, [1, 1, 1] |
| `clip` | persistent | Keeps the inside of `{ box: { min, max } }` or `{ sphere: { center, radius } }`, given in the splat's own space. `invert` keeps the outside instead. | — |
| `custom` / `custom:<name>` | custom | Your GLSL; see below. | — |

**Sorting.** The engine sorts splats by their ORIGINAL centres. Effects that keep each splat on
its own ray (inflate, the wavefront ridge) keep a valid order. So do effects that only hide or show
splats (sweep, fade, dissolve's reveal). A custom effect that moves splats far blends slightly out
of order while it is in flight.

**Comfort, for all-day kiosks.** No built-in effect moves a splat toward the viewer, except the
wavefront ridge. It moves at most `ridge` (3 cm), only for a moment, and never beyond
`ridgeMaxDisparity` (0.4 % of the view width) of extra disparity. At 1.7 m the 3 cm is well under
that cap; at 0.5 m the cap binds, at about 1.5 cm with a 64 mm eye separation.
`dissolve` lifts splats UP, never toward the viewer. Its sway has a small depth component, which
is why it is not offered as a setSource transition.

## Transitions between assets

**For photo slideshows use `crossfade` or `wavefront`.** These are the two approved photo-frame
transitions:

```js
await h.setSource(next, { fadeMs: 800 });                                   // crossfade
await h.setSource(next, { transition: 'wavefront' });                       // 2000 ms, ease-in-out
await h.setSource(next, { transition: 'wavefront', durationMs: 1800, ridge: 0.02 });
```

`setSource(next, o)`:

| `transition` | How | Default |
|---|---|---|
| `'cut'` | At once. | the default with no `fadeMs` |
| `'crossfade'` | Blends IMAGES. The last frame of the old asset is frozen into a texture (both eyes), and two overlay quads lerp it with the live new asset, `out = (1 − t)·A + t·B` per premultiplied pixel, alpha included. The result is linear in t whatever the depth order: blend fraction = t to ±0.001 at every tenth, identical in both eyes (1.12.1). The old photo holds still during the fade. | `fadeMs > 0` |
| `'flip'` (kept, not extended) | Phase 1: the old photo `deflate`s onto ITS convergence plane under ITS rig. The new photo is resident but hidden, so its work buffer builds meanwhile. At the flat moment the rig switches and the photos swap, with zero disparity on both sides. Phase 2: the new photo `inflate`s out of its own plane. | 2200 ms, `easeInOutSine` |
| `'wavefront'` | The photo-frame prototype's Wavefront Sweep. A soft front crosses the picture from left to right over normalised u. Each column commits from the old photo to the new one over `lt = clamp((t − u·(1 − band)) / band, 0, 1)` with a smoothstep, so u = 0 starts at t = 0 and u = 1 finishes at t = 1. **Image half:** the old photo is the frozen frame, and it gives way at the same viewport-relative u in every eye, a front on the zero-disparity plane. **Depth half:** a RIDGE rides the front on the new photo, `sin(π·lt) × ridge` world units toward the eyes. Each splat moves along its own ray, with its scale scaled by the same λ, so it keeps its place and size in the picture and only comes forward. The ridge is capped so its extra disparity never exceeds `ridgeMaxDisparity` of the eye view's width: `Δ ≤ cap · 2·tan(fovX/2) · d² / eyeSeparation`. u is the splat's angle in the transition's fixed camera frame (x/z; for a photo, its grid column), so it depends on world position only. With no frame to wipe from (a hidden tab), it falls back to the one-pass crossfade over the same duration. | 2000 ms, `easeInOutSine`, `band` 0.18, `ridge` 0.03 (m on a metric photo), `ridgeMaxDisparity` 0.004 |

`reveal` (with `cut` or `crossfade`) plays an entity-scope reveal on the INCOMING asset while the
old one fades. For example, `{ reveal: 'sweep', fadeMs: 500 }` fades the old frame out over
500 ms while the new photo sweeps in from its focus. `flip` and `wavefront` are their own reveals
and throw if `reveal` is also given.

Timing guidance from the photo-frame use case: gate only the FIRST photo on `firstWoven`, and
start slide-to-slide transitions at once. Use 1.5–2.5 s with ease-in-out, and a 6 s dwell.

The rig waterfall re-runs for the new file in every transition: rig, lens, focus and frame.
`crossfade` and `wavefront` switch the rig at once; the frozen old frame keeps its own look.
`flip` switches it at the flat moment.

## Custom GLSL

```js
h.setEffect('custom:tint', {
  glsl: `
    uniform float uAmount;
    void modifySplatColor(vec3 center, inout vec4 color) {
      color.rgb = mix(color.rgb, vec3(1.0, 0.8, 0.6), uAmount * dxrProgress);
    }`,
  uniforms: { uAmount: 0.4 },       // a number, 1–4 numbers, or (tMs) => value, set every frame
  scope: 'tile',                    // or 'entity'
});
h.playEffect('custom:tint', { glsl, uniforms, durationMs: 800 }); // dxrProgress 0 → 1, then removed
```

Write any of the engine's three functions; the missing ones are stubbed. The SDK renames them into
its chunk, after the built-in stages:

| Function | Inputs |
|---|---|
| `void modifySplatCenter(inout vec3 center)` | the splat centre, in WORLD space |
| `void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale)` | the rotation quaternion and the per-axis scale |
| `void modifySplatColor(vec3 center, inout vec4 color)` | colour + alpha. `center` is the MODIFIED centre, so key on a value you saved in the centre stage if you moved the splat |

Also available:

- **`dxrProgress`**: 0..1, eased when played; `progress` (default 1) when set.
- **`dxrTime`**: seconds since the effect started.
- **`splat.index`, `splat.uv`**: in `scope: 'entity'`, the asset's own FILE index (a SHARP photo is 2 layers × 768² in grid order, `i = layer·768² + y·768 + x`) and its texel in the asset's 768×1536 data textures. In tile scope these are work-buffer slots, not file indices. Measured: an entity custom effect hiding odd indices compiles and renders.
- **Engine helpers** such as `gsplatGetSizeFromScale(scale)`, and the SDK's `dxrFxHash(vec3)`, `dxrFxNoise(vec3)`, `dxrFxFbm(vec3)`.
- **Per-asset uniforms**: `scope: 'entity'` sets them on that asset only.

`fragmentGlsl` (tile scope only) sets the engine's per-fragment `gsplatModifyPS`:
`void modifySplatColor(vec2 gaussianUV, inout vec4 color)`, where `gaussianUV` is splat-local.

Refused, at the call:

- `gl_FragCoord`, `gl_Position`, `matrix_view`, `matrix_projection`, `matrix_viewProjection`, `viewport_size`, `view_position`, `uCameraPosition`.
- Uniform names starting with `dxr` or `gl_`.
- `fragmentGlsl` together with `scope: 'entity'`.

**Reading ANOTHER asset per splat (investigated, not built).** Several of the photo-frame
transitions need both photos' per-gaussian data at once, paired by index. One example is
"colour first, then geometry". At 2.22.3 this is **feasible**:

- A SOG resource's data textures are reachable as `asset.resource.streams.textures`: `means_l`, `means_u`, `quats`, `scales`, `sh0`, `sogCodebook`.
- An entity modifier on photo A can take photo B's textures through `gsplat.setParameter` and `texelFetch` them at `splat.uv`.
- Probe (headless, real GPU): B's `sh0` + codebook, decoded in A's modifier, painted B's colours onto A's geometry. The image changed by MAE 71 while alpha was untouched.

Building it needs a texture-uniform path in this API and B's other streams, for the geometry
half. That is a follow-up.

## Adding an effect

One registry entry in `js/inline3d-splat-effects.js` (`EFFECTS`):

- `stage`, `kind`, and `defaults`.
- `glsl(P)`, defining `P##center`, `P##rs` and `P##color`. Every body returns early at `amount >= 1`, so amount 1 is the baseline exactly.
- `uniforms(ctx, inst, amount, tMs)`, returning the values.
- Optionally `start(ctx, inst)`, for geometry fixed at start, and `validate(opts)`.

`ctx` gives `eyes()`, `focus()`, `framing()`, `pick()` and `modelToContent()`, all in world space.
The runner does composition, clocks, gates, removal and uniform upload.

## Gates

Headless Chrome on the real GPU (ANGLE Metal, Apple M1 Pro), engine 2.22.3, `ports_100_cam.sog`
(1,179,648 gaussians, camera block), 1280×720 per eye. The fake stereo is two RenderViews at
±32 mm with ±0.1 NDC skew on a 2560×720 buffer. Deterministic clock. Grey MAE /255.

**Every effect at progress 0 / 0.5 / 1** (`setEffect(name, { progress })`), MAE vs no effect:

| Effect | Mono p=0 / 0.5 / 1 | Stereo L, R at p=0.5 (lit fraction L / R) | Removal (grey, alpha; both eyes) |
|---|---|---|---|
| inflate (tile) | 0.000 / 0.000 / **0.000** (invisible from the eyes) | 5.76, 5.51 (1 / 1). Best-shift L/R residual 2.70 → 10.71 → 15.53 = depth arriving | 0.000 |
| inflate (entity) | 0.132 / 0.127 / **0.000** | 5.77, 5.52 | 0.000 |
| deflate | mirror of inflate; p=1 flat, residual 2.70 | 5.76, 5.51 | 0.000 |
| sweep (tile, entity) | 121.0 / 62.5 / **0.000** | 61.96, 62.57 (0.712 / 0.705) | 0.000 |
| fade | 121.0 / 41.1 / **0.000** | 41.83, 41.98 (0.999 / 0.999) | 0.000 |
| dissolve | 121.0 / 95.8 / **0.000** | 92.34, 99.32 (0.155 / 0.117, parallax on a sparse picture; L == R at coincident eyes) | 0.000 |
| pulse | 52.2 / 0.005 / **0.000** | 0.005, 0.005 | 0.000 |
| grade (0.5 stops, sat 0.3) | 29.9 | 29.97, 29.88 | 0.000 |
| clip (sphere r 0.6 m at the focus) | 116.9 | 115.9, 117.1 (0.078 / 0.078) | 0.000 |
| custom (tile, red tint) | 42.5 / 21.3 / **0.000** | 20.96, 21.42 | 0.000 |
| custom:idx (entity, `splat.index` odd hidden) | 5.55 | 5.73, 5.52 | 0.000 |

**Coincident eyes** (`sep 0`, `skew 0`): L == R, MAE 0.000, for every effect and progress, in both
scopes.

**`fade` coverage** (mean alpha / baseline at progress 0.1 … 0.9), `FADE_EFFECT_OPTICAL_DEPTH` 24:

| | 0.1 | 0.3 | 0.5 | 0.7 | 0.9 |
|---|---|---|---|---|---|
| ports | 0.12 | 0.37 | 0.57 | 0.74 | 0.89 |
| tahoe | 0.08 | 0.29 | 0.48 | 0.65 | 0.82 |
| family | 0.08 | 0.29 | 0.48 | 0.66 | 0.83 |

**Transitions** (ports → tahoe; frames stepped 50 ms). Each one ends at MAE **0.000**, colour and
alpha, vs a `cut` to the same asset, in mono and in stereo, and its promise resolves.

- **`flip`**: at the flat moment the L/R best-shift residual is **2.70**, the same as a fully deflated photo, so the swap happens at zero disparity.
- **`{ reveal: 'sweep', fadeMs: 500 }`**: the frozen old frame fades while the new photo sweeps in. Mid-transition screenshots, per eye, were checked by eye and kept local (the bench photo shows real people).
- **`wavefront`** (the prototype commit, linear easing, 2000 ms). Measured front position, taken where the blend crosses 0.5, at t = 0.25 / 0.5 / 0.75: **0.164 / 0.470 / 0.773** of the width, against the expected 0.195 / 0.500 / 0.805. The ~0.03 lag is one 50 ms step. The left and right eye are **identical** at every step. The ridge is present and small: at mid-transition, ridge 0.03 vs 0 changes the frame by MAE 0.21 (L) and 0.04 (R), and ridge 0.2 changes it by only 1.30 (L), because the disparity cap binds. Hidden-tab fallback (no frames drawn during the capture): the incoming asset gets the one-pass crossfade modifier and ends MAE 0.000 vs a cut.

**Frame cost** (ms per frame: 30 frames back to back + a 1-px `readPixels`, ÷ 30; median of 10
batches; the effect replayed every batch, so it animates throughout):

| | none | inflate tile | inflate entity | sweep tile | sweep entity | dissolve tile |
|---|---|---|---|---|---|---|
| mono | 7.96 | 7.79 | 7.04 | 5.33 | 4.86 | 3.96 |
| stereo | 18.10 | 18.73 | 13.20 | 13.05 | 8.92 | 7.43 |

Effects that hide splats are cheaper, because fewer splats get drawn. Entity scope runs with
`WORKBUFFER_UPDATE_ALWAYS`, which is faster in stereo even without an effect (the spike measured
19.5 → 15.5 ms). That is not understood yet, so do not read it as a recommendation.

**Rest view unchanged** (gate (a)): mono, camera rig from the block, vs the source photograph.
This branch equals `main`, MAE **0.000**; both read 2.131 in this harness. A finished `reveal`,
either `inflate` or `sweep`, is 0.000 vs no reveal, and `effects()` is empty afterwards.

**Not tested:**

- The DisplayXR Browser: a real weave, `firstWoven` timing on hardware, real eye motion during a frozen crossfade frame.
- Windows and Android GPUs.
- Streamed SOG with entity-scope effects (streamed chunks should inherit the modifier).
- `controls: 'page'` with effects.
- Two tiles with effects on one page.
- Effects on a display-rig object asset (only the camera-rig photo was gated).
- A `resize` or 2D↔3D switch during `wavefront` (the code path ends the transition; exercised on the fake engine only).

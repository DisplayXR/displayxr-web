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
| `addSplat(…, { reveal })` | `'inflate' \| 'sweep' \| 'dissolve' \| 'fade' \| 'assemble' \| 'dissolve-in' \| 'converge' \| 'shimmer' \| false \| { type, durationMs, holdMs, easing, origin, …params }`. The effect is installed at its start state before the asset's first frame. It plays once `handle.firstWoven` settles (at once in 2D) and the first two frames have built. |
| `handle.playEffect(name, opts) → Promise<{ finished }>` | A timed effect: `inflate`, `deflate`, `sweep`, `dissolve`, `fade`, the [particle reveals](#particle-reveals) (`assemble`, `dissolve-in`, `converge`, `shimmer`), `pulse`, `custom[:name]`. It is validated at the call and runs once the first asset is on screen. `finished` is false when the effect was stopped or replaced. |
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
| `assemble`, `dissolve-in`, `converge`, `shimmer` | reveal | Particle reveals: see [Particle reveals](#particle-reveals). | 2.4–2.6 s, `linear` (each particle eases out) |
| `custom` / `custom:<name>` | custom | Your GLSL; see below. | — |

**Sorting.** The engine sorts splats by their ORIGINAL centres. Effects that keep each splat on
its own ray (inflate, the wavefront ridge) keep a valid order. So do effects that only hide or show
splats (sweep, fade, dissolve's reveal). A custom effect that moves splats far blends slightly out
of order while it is in flight. The particle reveals move splats far, and hide it by keeping
each one a 1–2 px dot until it is nearly home (see below).

**Comfort, for all-day kiosks.** No built-in effect moves a splat toward the viewer, except the
wavefront ridge. It moves at most `ridge` (3 cm), only for a moment, and never beyond
`ridgeMaxDisparity` (0.4 % of the view width) of extra disparity. At 1.7 m the 3 cm is well under
that cap; at 0.5 m the cap binds, at about 1.5 cm with a 64 mm eye separation.
`dissolve` lifts splats UP, never toward the viewer. Its sway has a small depth component, which
is why it is not offered as a setSource transition. The particle reveals can come toward the
viewer only within their `maxDisparity` cap (default the same 0.4 %; see below).

## Particle reveals

```js
addSplat(wall, canvas, 'photo.sog', { engine: 'playcanvas', reveal: 'assemble' });
h.playEffect('converge', { durationMs: 2000 });                  // replay on the current photo
h.playEffect('shimmer', { order: 'layers' });                    // SHARP grid order (entity scope)
await h.setSource(next, { reveal: 'dissolve-in', fadeMs: 400 }); // on the incoming photo only
```

Every gaussian is a particle with its own start time. A key k ∈ [0, 1] per gaussian, set by
`order`, staggers it. Its local progress is `lp = clamp((t − k·stagger) / (1 − stagger), 0, 1)`,
where t is the eased clock. Each particle eases out along its own path and lands exactly home at
`lp = 1`.

| Effect | Look | Default |
|---|---|---|
| `assemble` | A swarm. Each gaussian starts in a cloud around the subject, mostly in the picture's plane and behind it rather than in front. The start field is part random, part a coherent noise field (`coherence`), so the swarm has streams. The particles fly home along a curl-noise path that spirals about the view axis through the origin, outward from the origin. | 2600 ms, `order: 'radial'`, `stagger` 0.6, `spread` 0.6, `swirl` 1.2 rad, `turbulence` 0.1, `coherence` 0.6, `depth` 0.3, a cool tint |
| `dissolve-in` | A dissolve played backwards. Faint dust drifts in on a slow wind and a noise swirl. It gathers into the picture patch by patch, on the same kind of fbm patches the dissolve burns along. | 2600 ms, `order: 'noise'`, `stagger` 0.75, `lift` 0.12, `drift` 0.35, a warm tint, `flightAlpha` 0.5 |
| `converge` | A burst from the origin (the focus by default). Particles launch nearest first and fly out, straight in the PICTURE and spiralling about the origin, to settle on their place. A particle not yet launched is not drawn, so the picture starts as one bright point and opens as a ragged disc. | 2400 ms, `order: 'radial'`, `stagger` 0.55, `spin` 0.9 rad, `burst` 0.04 |
| `shimmer` | Nothing moves. Each gaussian appears at home as a twinkling point and grows into its full splat. The order is random with a loose outward drift. | 2600 ms, `order: 'radial'`, `jitter` 0.85, `stagger` 0.8, `twinkle` 14 rad/s, `sparkle` 1.2 |

Options every particle reveal takes (plus `durationMs`, `holdMs`, `easing`, `origin`, `scope`):

- `order` sets the per-gaussian key:
  - `'radial'`: the distance in the picture from the origin, normalised to the view's farthest corner.
  - `'depth'`: near first, over the framed depth range.
  - `'noise'`: fbm patches.
  - `'random'`.
  - `'layers'`: a SHARP photo's grid order (`i = layer·768² + y·768 + x`). Layer 0, the visible surface, comes first, then layer 1, the disocclusion fill. Each layer goes outward from the origin. It reads `splat.index`, which is the file index only in a work-buffer modifier, so it forces `scope: 'entity'` and throws with `scope: 'tile'`. `layerSize` (default 768²) sets the layer length.
- `stagger` (0..0.95): the fraction of the duration spent launching.
- `jitter` (0..1): the random share of the key.
- `dotSize`: an in-flight particle is a dot of this fraction of the view width, whatever its depth. The default 0.0007 is a gaussian σ of about 1 px on a 1280 px view.
- `grow`: the particle grows back to its own splat over the last `1 − grow` of its flight.
- `flightAlpha`, `color`, `glow`: in-flight opacity and tint (`color · glow` is added).
- `noiseScale`: the size of the noise patches.
- `maxDisparity`: the comfort cap, below.

All sizes are in PICTURE units: half-view-widths at the gaussian's own depth. The same numbers
therefore look the same on a 2 cm object and a 40 m street. (Sizing by the framing box does
not: SHARP's framing box on a harbour photo is 127 m across.)

**Stereo.** Keys and paths read only the gaussian's ORIGINAL world centre, the time, and the
effect's frame. The frame is taken once when the effect starts: the eyes' midpoint and axes,
the lens extents and the origin. It is the same set of numbers for both eyes, so each particle is
in the same world place in both. The only screen-like input is the lens's tangent extents,
fixed at start, which size the `'radial'` key.

**Comfort.** No particle is ever nearer to the eyes than its home depth `dh` plus `maxDisparity`
of the eye view's width in extra disparity. The floor is `d ≥ dh / (1 + capK·dh)`, with
`capK = maxDisparity · 2·tan(fovX/2) / eyeSeparation`. It is exact: at every depth, the extra
disparity at the floor is the cap. A particle past the floor is pushed back along its own ray from
the eyes, so it keeps its place in the picture. The default cap is 0.004, the wavefront ridge's.
`maxDisparity: 0` means a particle never comes nearer than home. In 2D, with no eye separation, a
nominal 64 mm at 1.7 m, scaled to the focus distance, keeps the look of the woven tile. The swarm
is also built mostly in the picture's plane and behind it (`assemble`'s `depth`), so the cap rarely
binds.

**The sort caveat.** The engine sorts by ORIGINAL centres, so a particle far from home blends in
the wrong order. The particle reveals keep every in-flight gaussian a DOT (σ ≈ 1 px) until the
last `1 − grow` of its flight. By then it is within a few percent of home and its order is right.
A 1-px dot barely overlaps anything, so a wrong order does not show.

**The end state is the baseline.** Every stage returns at once at `amount >= 1`, and each
particle at `lp >= 1`. The runner removes the effect at the end, deleting the chunk or modifier.
The last frame is the plain render: MAE 0.000, colour and alpha (§Gates).

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
| `'crossfade'` | Blends IMAGES. Two overlay quads lerp the old photo's image A with the new one's B, `out = (1 − t)·A + t·B` per premultiplied pixel, alpha included. The result is linear in t whatever the depth order: blend fraction = t to ±0.001 at every tenth, identical in both eyes (1.12.1). A is LIVE in a woven 3D session: the old photo keeps rendering with head motion (see [Live or frozen outgoing](#live-or-frozen-outgoing)). | `fadeMs > 0` |
| `'flip'` (kept, not extended) | Phase 1: the old photo `deflate`s onto ITS convergence plane under ITS rig. The new photo is resident but hidden, so its work buffer builds meanwhile. At the flat moment the rig switches and the photos swap, with zero disparity on both sides. Phase 2: the new photo `inflate`s out of its own plane. | 2200 ms, `easeInOutSine` |
| `'wavefront'` | The photo-frame prototype's Wavefront Sweep. A soft front crosses the picture from left to right over normalised u. Each column commits from the old photo to the new one over `lt = clamp((t − u·(1 − band)) / band, 0, 1)` with a smoothstep, so u = 0 starts at t = 0 and u = 1 finishes at t = 1. **Image half:** the old photo's image (live in 3D, the frozen frame in 2D) gives way at the same viewport-relative u in every eye, a front on the zero-disparity plane. **Depth half:** a RIDGE rides the front on the new photo, `sin(π·lt) × ridge` world units toward the eyes. Each splat moves along its own ray, with its scale scaled by the same λ, so it keeps its place and size in the picture and only comes forward. The ridge is capped so its extra disparity never exceeds `ridgeMaxDisparity` of the eye view's width: `Δ ≤ cap · 2·tan(fovX/2) · d² / eyeSeparation`. u is the splat's angle in the transition's fixed camera frame (x/z; for a photo, its grid column), so it depends on world position only. With no frame to wipe from (a hidden tab), it falls back to the one-pass crossfade over the same duration. | 2000 ms, `easeInOutSine`, `band` 0.18, `ridge` 0.03 (m on a metric photo), `ridgeMaxDisparity` 0.004 |

`reveal` (with `cut` or `crossfade`) plays an entity-scope reveal on the INCOMING asset while the
old one fades. For example, `{ reveal: 'sweep', fadeMs: 500 }` fades the old frame out over
500 ms while the new photo sweeps in from its focus. `flip` and `wavefront` are their own reveals
and throw if `reveal` is also given.

Timing guidance from the photo-frame use case: gate only the FIRST photo on `firstWoven`, and
start slide-to-slide transitions at once. Use 1.5–2.5 s with ease-in-out, and a 6 s dwell.

The rig waterfall re-runs for the new file in every transition: rig, lens, focus and frame.
`crossfade` and `wavefront` switch the rig at once; the old photo keeps its own look (live: see
below; frozen: it is a still). `flip` switches it at the flat moment.

### Live or frozen outgoing

`setSource(next, { transition, outgoing: 'live' | 'frozen' })`, for `crossfade` and `wavefront`.

**Why.** In 1.12.1–1.13.0 the old photo was always a frozen frame for the whole window (800 ms
crossfade, 2000 ms wavefront). On a tracked 3D panel a still image under a moving head reads
exactly as "eye tracking hung, then resumed", and it dominates most of a fade, because the
incoming photo starts invisible.

| `outgoing` | What the old photo is during the window | Cost | Default |
|---|---|---|---|
| `'live'` | Still resident, re-rendered every frame through the same eye views (head motion included), into its own render target; the overlay lerps / wipes the two live images per eye. | about 2× splat draw for the window; both assets resident | woven (3D) session |
| `'frozen'` | Its last frame, copied to a texture (1.12.1). | one draw; the old asset is released at the start | 2D |

How live works on the engine's single-camera N-RenderView path: a second camera with its OWN
RenderViews (set from the same entries as the eye's every frame) renders into an RGBA8 target the
size of the canvas buffer, so every eye viewport sits in it exactly where it sits on the canvas.
The old asset moves to its own layer that only this camera renders: the engine keeps one gsplat
manager (work buffer, sort, budget) per camera × layer, so the eye's manager holds only the new
asset and the live camera's only the old one, never both in both. The frozen capture bridges the
first frames, until the live camera's manager has drawn a sorted frame (2 frames on the M1). When
the window ends the camera is disabled, which drops its manager, and the old asset is released as
before. On an engine build without the RenderView path the transition falls back to `'frozen'`.

The incoming photo's rig is adopted at once, so the views the runtime returns from then on are the
NEW photo's. The live camera sits under a node chain `N = R_o·K_o·D_o·(K_n·D_n)⁻¹` that maps them
back to the old photo's framing: R is the rig node, K the capture/mono pose, and
`D = diag(c·t, c·t, c)` with c the convergence distance and t = tan(fov/2). The old photo keeps its
own window and zero-disparity plane. Two display-rig assets reduce to the old rig node.

**Measured** (headless Chrome, M1, real GPU, a fake 2-view wall, `ports_100_cam.sog` →
`mg_tahoe_k100.sog`, 1,179,648 gaussians each):
- **Head tracking of the old photo.** Mid-crossfade, with the old photo at weight 1, at four head
  poses (lateral, lateral + vertical, depth), both eyes match that photo's own plain render at the
  same pose with MAE 0.000. That holds across the rig switch, since the two files have different
  lenses and convergence. `'frozen'` and 1.13.0 show the same image at every head pose (MAE 0.000
  frame to frame): that is the "hung" look.
- **Exactness.** The end state equals a plain `cut` with MAE 0.000, colour and alpha, in both eyes,
  for live `crossfade` and live `wavefront`. Mid-crossfade at t = 0.5, the frame equals the lerp of
  the two photos' own renders to 0.39 grey levels (8-bit rounding), in both eyes.
- **Resources during the window.** Two gsplat managers (`World`, `inline3d-outgoing`), resident
  2 × 1,179,648. GPU textures go from 58.8 MB to 131.6 MB, +73 MB (the second work buffer and the
  target); `'frozen'` adds 7 MB, the capture. After the window: one manager, and the live target
  freed.
- **Cost.** With a GPU-synced frame time (a 1-px readback each frame; no throttling;
  2560×720 buffer), a steady frame is 14.5 ms. It is 25.2–25.6 ms during a live window and
  13.1–13.7 ms during a frozen one. Under 4× and 6× CPU throttling the longest rAF gap inside the
  window is 26–28 ms live and 19–20 ms frozen, with no long task in either. Starting the live
  camera costs no long task either: the first frames show the frozen bridge while its manager
  builds its work buffer and first sort. Full tables:
  [`playcanvas-adapter.md` § setSource](playcanvas-adapter.md#setsource--what-a-swap-costs-the-main-thread).

### Preloading the next photo: `prepareSource`

```js
let next = await h.prepareSource(urls[i + 1]);  // during the dwell: fetch, decode, upload
// … 6 s later …
await h.setSource(next, { transition: 'wavefront' }); // no load on the transition frame
next = null;
```

`prepareSource(src)` runs the same load as `setSource`: the engine's SOG load, whose own
end-of-load unpack runs when it must, and the SDK's cloud passes (framing, rig sample, pick set),
which here yield to IDLE periods rather than `scheduler.yield()`. It does not render the asset. The
result is an opaque, single-use handle; `setSource(prepared, …)` starts the transition on the next
frame. Use `prepared.dispose()` if the page changes its mind, and `remove()` disposes any still
unused. A prepared result from another handle is refused.

**Memory:** a prepared asset is fully resident alongside the current one until it is used. That is
+22.5 MB of GPU textures per 1.18M-gaussian SOG (58.8 → 81.3 MB, back to 58.8 on `dispose()`), plus the engine's centre array (1.18M × 3 float32 ≈ 14 MB of JS heap). During a live transition that follows, both photos
are drawn (see above). Prepare one slide ahead, not a playlist.

**What preloading does not move:** the new asset's first drawn frame still builds its work buffer
and first sort (the transition's first frame); the fade clock starts on the second tick for that
reason.

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
- `glsl(P, opts)`, defining `P##center`, `P##rs` and `P##color`. Every body returns early at `amount >= 1`, so amount 1 is the baseline exactly. `opts` are the resolved options, for code that depends on them (the particle reveals' `order`).
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

**Particle reveals** (same harness). Grey MAE /255 against no effect:

| Effect (tile) | mono p = 0.2 / 0.5 / 0.8 / **1** | end of a PLAYED run: mono; stereo L, R (colour, alpha) | removal: mono, stereo | coincident eyes L vs R at 0.2 / 0.5 / 0.8 |
|---|---|---|---|---|
| assemble | 91.0 / 73.9 / 5.6 / **0.000** | 0.000; 0.000, 0.000 (0.000, 0.000) | 0.000 | 0.003 / 0.003 / 0.001 |
| dissolve-in | 71.0 / 47.6 / 9.0 / **0.000** | 0.000; 0.000, 0.000 (0.000, 0.000) | 0.000 | 0.004 / 0.002 / 0.001 |
| converge | 120.2 / 100.5 / 7.5 / **0.000** | 0.000; 0.000, 0.000 (0.000, 0.000) | 0.000 | 0.000 / 0.001 / 0.001 |
| shimmer | 92.0 / 11.0 / 3.2 / **0.000** | 0.000; 0.000, 0.000 (0.000, 0.000) | 0.000 | 0.002 / 0.002 / 0.001 |

- Entity scope matches tile scope to ±0.02 at every progress, and its end state, removal and played run are also 0.000.
- `order: 'layers'` (assemble), `'depth'` (shimmer) and `'random'` (dissolve-in) also end at 0.000.
- Every played run resolves `{ finished: true }` and leaves `effects()` empty.
- **Coincident eyes are not bit-identical here**, unlike the effects above. Measured at full resolution:
  - the particles leave at most 2/255 on at most 1.1 % of pixels (assemble); the others leave 1/255.
  - the plain render already differs by 1/255 on 0.11 % of pixels.
  - the difference is the same from one frame to the next.

  Every input is the same in both views, so this reads as raster rounding of sub-pixel dots, not
  a keying difference.
- The comfort floor is exact by construction (`test/splat-particles.test.mjs`); no pixel measurement.

**Particle reveal cost** (ms per frame, method as above). This GPU was shared with a desktop
browser during these runs, so the baselines themselves moved (stereo `none`: 19.2 in one run, 25.5
in the next). Read the numbers as a range. Held at progress 0.5, the busiest steady state
(median, min):

| | none | assemble | dissolve-in | converge | shimmer |
|---|---|---|---|---|---|
| mono, tile | 10.8 (8.8) | 17.5 (10.8) | 16.3 (10.5) | 9.9 (9.2) | 6.9 (6.2) |
| stereo, tile | 25.5 (20.2) | 28.2 (21.2) | 23.5 (23.3) | 27.7 (22.3) | 19.2 (13.9) |
| mono, entity | — | 13.5 (11.8) | 15.4 (14.1) | 14.8 (13.6) | 15.1 (12.6) |
| stereo, entity | — | 26.9 (16.1) | 27.6 (17.5) | 26.0 (15.0) | 16.3 (10.5) |

Replayed from t = 0 every batch (the first quarter of each effect), mono tile ran none 8.9,
assemble 10.0, converge 3.9, shimmer 3.4. Converge and shimmer do not draw particles that have
not launched yet, so they start cheaper than the plain photo.

**Not tested:**

- The DisplayXR Browser: a real weave, `firstWoven` timing on hardware, real eye motion during a frozen crossfade frame.
- Windows and Android GPUs.
- Streamed SOG with entity-scope effects (streamed chunks should inherit the modifier).
- `controls: 'page'` with effects.
- Two tiles with effects on one page.
- Effects on a display-rig object asset (only the camera-rig photo was gated).
- A `resize` or 2D↔3D switch during `wavefront` (the code path ends the transition; exercised on the fake engine only).
- Particle reveals on the real 3D display: how the swarm and its comfort cap feel woven, and whether the default cap should be larger.
- Particle reveals: the engine's colour-only work-buffer pass. If the engine ever re-colours without re-running the centre stage, an entity-scope particle's in-flight colour would key on its moved centre. The end state is unaffected.
- Particle reveals on Windows/Android GPUs, on streamed SOG, and with `order: 'layers'` on a non-SHARP asset.

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
| `handle.setSource(src, { transition, durationMs, easing, reveal, fadeMs, resetPose, … })` | Swap the asset. See [Transitions between assets](#transitions-between-assets), [Particle transitions](#particle-transitions) and [Sequence transitions](#sequence-transitions-one-splat-at-a-time). |
| `handle.prepareSource(src, { transition, … })` | Load the next asset in the background; with a particle `transition`, also compile its shaders in the dwell. With a sequence `transition`, only FETCH it (see [Sequence transitions](#sequence-transitions-one-splat-at-a-time)). See [prepareSource](#preloading-the-next-photo-preparesource). |

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
| `'wavefront'` | The photo-frame prototype's Wavefront Sweep. A soft front crosses the picture from left to right over normalised u. Each column commits from the old photo to the new one over `lt = clamp((t − u·(1 − band)) / band, 0, 1)` with a smoothstep, so u = 0 starts at t = 0 and u = 1 finishes at t = 1. **Image half:** the old photo's image (live in 3D, the frozen frame in 2D) gives way at the same viewport-relative u in every eye, a front on the zero-disparity plane. **Depth half:** a RIDGE rides the front on the new photo, `sin(π·lt) × ridge` world units toward the eyes. Each splat moves along its own ray, with its scale scaled by the same λ, so it keeps its place and size in the picture and only comes forward. The ridge is capped so its extra disparity never exceeds `ridgeMaxDisparity` of the eye view's width: `Δ ≤ cap · 2·tan(fovX/2) · d² / eyeSeparation`. u is the splat's angle in the transition's fixed camera frame (x/z; for a photo, its grid column), so it depends on world position only. The ridge runs at render time, and each photo is drawn only on its own side of the front (see [Wavefront: one draw's worth](#wavefront-one-draws-worth)). With no frame to wipe from (a hidden tab), it falls back to the one-pass crossfade over the same duration. | 2000 ms, `easeInOutSine`, `band` 0.18, `ridge` 0.03 (m on a metric photo), `ridgeMaxDisparity` 0.004 |

| `'swarm'`, `'burst'`, `'shimmer-cross'`, `'dust'` | Particle transitions: the old photo plays a particle reveal backwards while the new one plays it forwards, both live. See [Particle transitions](#particle-transitions). | 2600–2800 ms, linear shared clock (each particle eases) |
| `'reassemble'`, `{ type: 'sequence', out, in }` | Sequence transitions: ONE photo at a time. The old photo plays a reveal backwards until nothing of it is drawn, is released, and the new one plays a reveal forwards. No second camera, no overlay, no capture. See [Sequence transitions](#sequence-transitions-one-splat-at-a-time). | 3000 ms: 45 % out, a 10 % empty beat, 45 % in |

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
| `'live'` | Still resident, re-rendered every frame through the same eye views (head motion included), into its own render target; the overlay lerps / wipes the two live images per eye. | `crossfade`: 2× splat draw for the window (every pixel needs both images). `wavefront`: each photo drawn only on its side of the front, about 1.2–1.3× a still photo. Both assets resident | woven (3D) session |
| `'frozen'` | Its last frame, copied to a texture (1.12.1). | one draw; the old asset is released at the start | 2D |

How live works on the engine's single-camera N-RenderView path: a second camera with its OWN
RenderViews (set from the same entries as the eye's every frame) renders into an RGBA8 target the
size of the canvas buffer, so every eye viewport sits in it exactly where it sits on the canvas.
The old asset moves to its own layer that only this camera renders: the engine keeps one gsplat
manager (work buffer, sort, budget) per camera × layer, so the eye's manager holds only the new
asset and the live camera's only the old one, never both in both. When the window ends the camera
is disabled, which drops its manager, and the old asset is released as before. On an engine build
without the RenderView path the transition falls back to `'frozen'`.

**The pre-sort** (after 1.19.2). A fresh manager draws nothing until its first sort comes back
from its sort worker, so until then the overlay showed the frozen capture: the old photo as a still,
at full weight, right as the transition starts (2–7 frames measured; see
[`playcanvas-adapter.md` § Diagnosing transition stalls](playcanvas-adapter.md#diagnosing-transition-stalls-diag--dxrdiag-36)).
Now the live camera starts BEFORE the swap: the current asset is put on the live layer in addition
to its own, so the eye keeps drawing it untouched (its placement set does not change) while the
live camera's manager builds its work buffer and sorts. At the swap only the World placement goes,
the live layer's set is unchanged, the manager keeps its sorted state, and the overlay samples the
live target from the swap frame on. The price is latency, not a freeze: the transition starts once
that sort is back (bounded at 1.5 s; a hidden tab or a stalled sorter falls back to the bridge).
`?dxrdiag=cold` restores the old path for an A/B.

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

### Wavefront: one draw's worth

The live `crossfade` draws both photos in full for the whole window, and must: at mid-fade every
pixel is `(1 − t)·A + t·B`, so it needs both images. The `wavefront` does not. At any moment a
column shows the old photo, the new one, or (inside the `band`) both. So since the unreleased
patch after 1.19.1:

- **The ridge runs at render time.** It used to be an entity-scope work-buffer modifier, which
  forces the engine's `WORKBUFFER_UPDATE_ALWAYS`: a full rewrite of the new photo's work buffer
  and a CPU re-sort, every frame (0.92–0.96 of each per frame, measured). It is now a tile-scope
  body whose values sit on the eye camera's gsplat manager, as the particle transitions' do. The
  old photo's manager (the live camera's) gets no values, so it reads the material default: no
  ridge.
- **Each photo is drawn only on its side of the front.** The overlay's wipe gives column u the
  commit `lt = clamp((t − u·(1 − band)) / band, 0, 1)`. The new photo's weight is 0 wherever
  u ≥ t / (1 − band), and the old photo's wherever u ≤ (t − band) / (1 − band). An internal last
  stage, `wipecull`, gives a gaussian alpha 0 (the engine's own alpha clip then drops it in the
  vertex stage) when its whole footprint lies past that edge in every eye.
  - The footprint is bounded the way the engine sizes its quad (`gsplatCorner`):
    `λ₁ ≤ ‖J‖²·s²·σ²max + 0.3`, with `‖J‖² = (f/z)²·(1 + (x² + y²)/z²)` and s the view's scale.
    Then `l₁ = 2·√(2λ₁)`, a corner reaches at most `2·l₁`, and 4 px are added.
  - It uses the final centre and scale, so the ridge and any tile effect before it are included.
  - The eye views are the ones the engine composes that frame (the camera's parent world
    transform · each view's pose). The adapter hands them over just before the engine renders.
  - A unit test checks the bound against the engine's quad in JS, over 4,000 random gaussians,
    views, skews and view scales. Shrinking the margin fails it.
  - It only removes gaussians no shown pixel can receive, so it is not an effect in the sense of
    the stereo rule. `viewer._wipeCull = false` turns it off, for the gate below.

Result: the two photos share the GPU only inside the band, plus the vertex stage of the culled
ones (about a quarter of a draw).

**Gates** (headless, real GPU, M1; Tahoe → bakery, `5e5c097e.mono.sog` → `a36d278b.mono.sog`,
1,179,648 gaussians each):

- **Cull on vs off:** bit-identical at t = 0.1, 0.3, 0.5, 0.7 and 0.9, in both eyes and in 2D:
  MAE 0.000, max 0, colour and alpha.
- **End vs `cut`:** 0.000, both eyes, colour and alpha, for live `crossfade`, live `wavefront` and
  frozen `crossfade`. The same holds for `ports_100_cam.sog` → `mg_tahoe_k100.sog`.
- **Crossfade midpoint:** the lerp of the two photos' own renders to 0.39 grey levels (8-bit
  rounding), in both eyes, as before.
- **Head tracking (the 4-pose test):** with the old photo at weight 1, `crossfade` and `wavefront`
  both match that photo's own render at each head pose with MAE 0.000 on the PR #55 pair
  (`ports_100_cam` → `mg_tahoe_k100`). On Tahoe → bakery it is 0.001, and 1.19.1 gives the same
  0.001.
- **Resources:** VRAM goes 58.8 → 131.6 → 58.8 MB, and there is 1 manager after the window.

**GPU cost** (a 30-frame batch plus a 1-px `readPixels`, median of 10 batches, held at t = 0.5,
median of 3 page loads). Each cell is the window's frame time as a multiple of the still photo's
on the same page:

| | 1.19.1 | now |
|---|---|---|
| stereo `wavefront` | 1.66× | **1.42×** |
| stereo `crossfade` | 1.76× | 1.95× (same code; both draw two photos) |
| 2D `wavefront` | 1.31× | **1.22×** |
| 2D `crossfade` (live) | 1.52× | 1.55× |

In the same page at t = 0.5, the cull alone takes a stereo frame from 40.8 to 31.2 ms (2D: 12.8 to
8.9 ms). With every gaussian culled, a photo still costs about 6 of its 22–25 ms stereo frame:
that is the vertex stage, which is what remains above 1×.

Where the live `crossfade` goes (stereo, held at t = 0.5, 1.19.1): hiding the old photo's draw
brings the frame to the still photo's, and so does hiding the new one's. Hiding both leaves
0.3–0.5 ms: the target clear, the overlay's two quads and the rest. The target is the canvas buffer
(each eye draws only its own viewport), and it is made once per window. With a still head, sorts
run only at the start (0.05–0.1 per frame over the window).

**Pacing, as seen:** a visible Chrome 153 window, 120 Hz, M1 Pro, `prepareSource(src,
{ transition })` then `setSource`, one configuration per launch, before and after interleaved,
5 launches each. Each cell is the median of the runs' rAF interval over the window:
median / p95 / p99 / max, then frames over 25 ms of all frames.

**This Mac was very busy during these runs** (load average 11–95, with another agent's headless
Chrome on the GPU). The still photo, measured first on every page, read 15–18 ms in 2D and 26–29 ms
in stereo, where a quiet machine reads 8.3 and 15.5. Compare the columns, not the absolute values.

| | still (same pages) | 1.19.1 | now |
|---|---|---|---|
| 2D `wavefront` (live) | 14.6–16.7 | 25.5 / 42.5 / 77.9 / 77.9, 43 of 83 | **17.2 / 28.8 / 32.9 / 39.5, 19 of 117** |
| stereo `wavefront` | 26.8–28.9 | 58.0 / 120.9 / 121.7 / 121.7, 31 of 39 | **35.2 / 55.5 / 63.1 / 63.1, 50 of 60** |
| 2D `crossfade` (live) | 16.9–17.1 | 18.7 / 40.8 / 57.9 / 57.9, 15 of 39 | 24.4 / 46.0 / 77.6 / 77.6, 15 of 33 |
| stereo `crossfade` | 26.5–27.3 | 41.0 / 91.9 / 98.3 / 98.3, 18 of 25 | 41.4 / 57.6 / 68.0 / 68.0, 20 of 22 |

Per frame in the `wavefront` window: work-buffer rewrites 0.92–0.94 → 0.02–0.03, sort requests
0.92–0.94 → 0.02–0.03, sort results on the main thread 1.3–4.0 → 0.05–0.13 ms. Program links inside
the window: 3 → 0 (`wavefront`), 2 → 0 (`crossfade`); see the pre-warm below. The 2D `wavefront`
now paces like the still photo. The stereo one draws about 1.4 photos' worth, as the GPU table
says. The `crossfade`'s median does not move: 1.19.1's window contained a 25–100 ms link stall
followed by cheaper frames, and without the stall there are fewer, evenly heavy frames.

**Not shipped: a half-rate old photo in the `crossfade`.** Drawing the old photo on alternate
frames only, and keeping its target in between, took a stereo `crossfade` from 40.8–42.4 to
29.1–36.1 ms median in the same conditions. It was not kept. Every other frame, the old photo
would be a frame behind the head, and that is exactly what the live outgoing exists to prevent. It
cannot be judged without a tracked panel.

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
are drawn (see above). Prepare one slide ahead, not a playlist. A sequence transition
(`prepareSource(src, { transition: 'reassemble' })`) is the exception: its prepare only fetches the
bytes, so one splat stays resident (see [Sequence transitions](#sequence-transitions-one-splat-at-a-time)).

**What preloading does not move:** the new asset's first drawn frame still builds its work buffer
and first sort (the transition's first frame); the fade clock starts on the second tick for that
reason.

## Particle transitions

```js
let next = await h.prepareSource(url, { transition: 'swarm' }); // during the dwell: load + compile its shaders
// … 6 s later …
await h.setSource(next, { transition: 'swarm' });                // 2800 ms
await h.setSource(other, { transition: 'dust', order: 'random', overlap: 0.6 });
```

These are the particle reveals, played across a slide change. The OUTGOING photo plays one
backwards: its gaussians leave home as dots and thin out to nothing. The INCOMING photo plays one
forwards. The two run on overlapping spans of one clock. Both photos are live in every eye in 3D,
and in 2D.

| `transition` | Outgoing photo | Incoming photo | Default |
|---|---|---|---|
| `swarm` | disperses into a curl-noise swarm (`assemble` reversed): outermost first, spiralling out about the view axis | assembles out of a swarm (`assemble`) | 2800 ms, overlap 0.45. Both photos: `stagger` 0.65, `spread` 0.3, `swirl` 1.8, `density` 0.2. `vanish` 0.45 out, 0.35 in |
| `burst` | collapses into its focus point (`converge` reversed): outermost first; the picture shrinks to a ragged disc, then to a point | bursts out of its own focus point (`converge`), nearest first | 2600 ms, overlap 0.3, `density` 0.5 |
| `shimmer-cross` | breaks into twinkling points and fades (`shimmer` reversed). Nothing moves | materialises from twinkles (`shimmer`) | 2600 ms, overlap 0.45 |
| `dust` | dissolves into drifting dust, patch by patch (`dissolve-in` reversed) | gathers from dust (`dissolve-in`) | 2800 ms, overlap 0.4, `density` 0.4. `vanish` 0.4 out, 0.3 in |

**Timing.** The shared clock is `linear` by default, and each particle eases along its own path: a
leaving particle eases in and an arriving one eases out. That is where the ease-in-out comes from.
We tried an eased shared clock on top. The first and last fifth of the window then barely moved:
the frames at t = 0.2 and t = 0.8 could not be told apart from the two stills. Passing `easing`
still shapes the shared clock.

`overlap` (0..1) is how much of the clock the two spans share. The outgoing photo runs over
[0, (1 + overlap)/2] and the incoming one over [(1 − overlap)/2, 1]; 0 means one after the other.
The clock starts the way the crossfade's does: on the second frame after the swap, and only once
the live camera has drawn a sorted frame. Until then the frozen capture shows the old photo,
untouched.

**Options.**

- Shared by BOTH photos: `order`, `stagger`, `jitter`, `maxDisparity`, `dotSize`, `noiseScale`,
  `origin`.
- `order` must be the same for both, and `'layers'` is refused (see How).
- Per photo: `outgoingFx: { … }` and `incomingFx: { … }` take any option of that photo's particle
  effect, for example `incomingFx: { spread: 0.2 }`.
- Everything is validated at the call.
- `reveal` throws, because these transitions are their own reveals.

Two options are new to the particle effects. The reveals keep both off:

- `vanish` (0..1): a particle fades over the first `vanish` of its flight. A swarm gathers out of
  nothing, and a leaving photo's swarm thins out to nothing.
- `density` (0..1): the share of gaussians drawn while in flight; the rest appear as they grow
  home. At 1.18M gaussians, a full swarm of 1 px dots covers every pixel and reads as TV snow.
  At 0.2 it reads as a swarm.

**How: render time, one chunk, two mesh instances.** Both photos run ONE generated body in the
tile's render-time vertex stage (`gsplatModifyVS`). Each photo's values sit on the mesh instance
of the gsplat manager that draws it:

- the eye camera's manager draws the incoming photo;
- the [live outgoing](#live-or-frozen-outgoing) camera's manager, on its own layer, draws the
  outgoing photo.

The engine gives every manager's renderer its own material and copies the tile material's chunk
into it, so one chunk serves both. Per-mesh-instance uniforms override the material's, so the two
photos play different sides.

Nothing is rewritten per frame. An entity-scope work-buffer modifier, which was the first cut,
forces the engine's `WORKBUFFER_UPDATE_ALWAYS`. On two 1.18M assets that meant, every frame:

- two full work-buffer rewrites;
- two CPU sort requests, and about 1.2 order-texture uploads (3 ms of main thread);
- about 350 KB of garbage.

That is the unsmoothness measured under §Gates. The sort still keys on each gaussian's ORIGINAL
centre, as for the reveals, so in-flight gaussians stay ~1 px dots.

A photo with nothing to draw is not drawn: its mesh instance is turned off. That covers the
incoming photo before its span starts and the outgoing one after its span ends, when every
particle is hidden (`converge`, `shimmer`, or `vanish` > 0). The two photos therefore share the
GPU only while their spans overlap.

The overlay composites the two live images per eye, the old one OVER the new one:
`out = A + (1 − A.a)·B`, premultiplied, with the crossfade's two quads (`dxrSnapOver`). Paths
are keyed on world position and time, so both eyes agree. The `maxDisparity`
comfort floor applies to each photo against its own home depth.

Each photo's frame (eyes, focus, framing) is its own. The outgoing photo's frame is taken before
the rig switches; the incoming photo's is taken again when the clock starts. `order: 'layers'`
reads the FILE index `splat.index`, which a render-time body does not have (there it is a
work-buffer slot), so transitions refuse it.

An engine whose managers are not reachable falls back to the entity-scope modifiers: the result
is correct, but it hitches on large files. The `wavefront`'s ridge does the same. There the
fallback draws both photos in full. `handle.viewer._transitionPath` says which path ran
(`'render'` or `'entity'`), for diagnostics.

**Shader pre-warm: `prepareSource(src, { transition, …})`.** The first transition of each kind in a
page compiles a new program variant, and its first frame blocks on the link. Measured on the M1:

- 35–50 ms when the machine has seen the variant before;
- 190 + 260 ms the first time ever;
- plus the two overlay quads, on the very first transition.

Pass the transition (and the options that shape the shader, `order`) to `prepareSource`. It then
builds the same variants in the dwell and finishes their link there. It asks the engine's program
library with a throwaway material that copies the eye renderer's description, defines and chunks
and adds the transition's chunk. The library keys on the generated source, so the renderer gets
this program back on the transition's first frame. It then polls `KHR_parallel_shader_compile`
in idle periods, and finalizes when the link is done. Creating a program is not enough: the
browser resolves the link on the first query, which is the draw. The warm-up is best effort: an
engine whose internals differ compiles on the first frame, as before.

The `wavefront` has a render-time variant too (its ridge and cull), warmed the same way. The
overlay's two quads, which every `crossfade`, `wavefront` and particle transition draws through,
are warmed by ANY `prepareSource`, and by an unprepared `setSource` while its asset loads. Before
that, they linked on the first frames of each page's first window (about 25–180 ms on the M1).

**End state.** The chunk is deleted and each photo's values are removed from its mesh instance.
The overlay is hidden. The live camera is disabled, which drops its manager, and its target is
freed. The old asset is released. The frame is a plain `cut`: MAE 0.000, colour and alpha, both
eyes (§Gates).

**Fallbacks.**

- Hidden tab, or no frame copy: nothing is captured, so the transition becomes the one-pass
  crossfade over the same duration, as `wavefront` does.
- `outgoing: 'frozen'`, or an engine without the RenderView path: the old photo cannot move, so
  its frozen frame fades out over the outgoing span while the new photo plays its side.
- Particle transitions default to `outgoing: 'live'` in 2D too, because the old photo moves.

## Sequence transitions: one splat at a time

```js
let next = await h.prepareSource(url, { transition: 'reassemble' }); // dwell: FETCH only + compile
// … 6 s later …
await h.setSource(next, { transition: 'reassemble' });               // 3000 ms
await h.setSource(url, { transition: { type: 'sequence', out: 'sweep', in: 'converge' } });
```

The old photo plays a reveal BACKWARDS until nothing of it is drawn. Then it is released, the next
photo is loaded and placed, and that one plays a reveal FORWARDS. `'reassemble'` is the named one:
the photo disperses into a swarm (`assemble` backwards) and the next one assembles out of one.

**Why.** Every other animated transition keeps the OLD photo alive next to the new one: a second
camera with its own RenderViews, its own layer and gsplat manager, a render target and the overlay
quads that composite the two (see [Live or frozen outgoing](#live-or-frozen-outgoing)), with a
frozen capture as the fallback. A sequence has none of it. The eye camera renders every frame, with
one asset in the scene, the way it renders a still photo, so nothing in the transition can hold an
image still while the head moves. It is the fallback if a tracked panel still shows a pause with
the others, and an effect on its own.

**Options.**

| | |
|---|---|
| `transition: 'reassemble'` | `assemble` out, `assemble` in, 3000 ms, `linear` shared clock (each particle eases), `beat` 0.1 |
| `transition: { type: 'sequence', out, in, durationMs?, beat?, easing? }` | any two of `assemble`, `dissolve-in`, `converge`, `shimmer`, `sweep`, `fade`. Its own keys read like setSource's; setSource's win. Defaults 3000 ms, `linear`, `beat` 0.1 |
| `beat` (0..0.9) | the share of `durationMs` that is empty between the two. Out and in get `(1 − beat) / 2` each: 45 / 10 / 45 by default |
| `outgoingFx`, `incomingFx` | option overrides per side, as for the particle transitions |
| `order`, `stagger`, `jitter`, `maxDisparity`, `dotSize`, `noiseScale`, `origin` | shared by both sides when they are particle reveals (`sweep` and `fade` take only `origin`) |

Refused at the call: `reveal` (the sequence is its own reveal), `outgoing` (there is no outgoing
image), `order: 'layers'`, and any side that would still draw something at its start. That last
rule is what makes the swap invisible: the old photo is gone before the new one appears, and the
new one appears from nothing. It is why `inflate` is not offered (its end state is a flat photo:
that swap is `'flip'`), why `dissolve` is not (its sway has a depth component, see Comfort), and why
the particle sides default to the particle transitions' tuned options: the `swarm` sides for
`assemble` (`vanish` 0.45 out / 0.35 in, `density` 0.2), `dust` for `dissolve-in`, `burst` for
`converge`, `shimmer-cross` for `shimmer`. `incomingFx: { vanish: 0 }` on `assemble` throws.

**How.**

1. **Out.** The current photo's reveal runs backwards as a TILE-scope body at render time (no
   work-buffer rewrite, no re-sort), its values on the tile material. Its frame (eyes, focus,
   framing) is taken at the start, under the photo's own rig. Meanwhile the next file's BYTES are
   fetched (for a URL; a `prepareSource` result is already in hand).
2. **Swap.** At amount 0 nothing of the photo is drawn. If the next file came back as an HTTP
   error, the photo plays back in and `setSource` rejects: the current photo stays. Otherwise the
   old asset is released and DESTROYED (entity, then its resource, a few frames later as every
   release is). Only then is the next file given to the engine: decoded, uploaded, measured, and
   placed. The rig waterfall runs and the rig is declared in the same task, with the in body at
   amount 0, so its first frame draws nothing.
3. **Beat.** The tile stays empty for at least `beat` of the clock, and for at least 3 frames of
   the new photo (its work buffer and first sort build, and the new rig has been declared for 3
   frames).
4. **In.** Its frame is re-taken under the new rig, and the reveal runs forwards. At the end the
   body is removed and the chunk deleted: the plain render, exactly.

Both bodies are named `transition`, the particle transitions' name, so a `reassemble` compiles the
same program as a `swarm`. Keys and paths read world positions only (both eyes agree), and the
particle sides keep the `maxDisparity` comfort floor against their own home depth.

**What "one splat resident" means.** At any moment at most ONE splat asset is loaded in the engine
(its GPU textures and its centre array) and at most one splat entity is in the scene. During the
out phase the next file exists only as bytes in JS memory (about 11 MB for a 1.18M-gaussian SOG).
The next asset reaches the engine only after the old one's entity is destroyed and its resource
unloaded.

- `prepareSource(src, { transition: 'reassemble' })` therefore only FETCHES (and compiles the two
  bodies). `prepared.numSplats` is `null` until the swap. The decode and upload run at the swap, in
  the empty beat.
- `prepareSource(src, { transition: 'reassemble', resident: true })` opts back into the full
  prepare: the next asset is decoded and uploaded in the dwell (resident, not in the scene), so the
  swap has no load. Two assets are resident during the dwell, as with any other `prepareSource`.
- A plain `prepareSource(src)` result passed to a sequence is resident too, by the same rule.
- An unprepared URL is fetched during the out phase. A URL the engine must resolve itself (a
  Streamed SOG, an unbundled SOG's `meta.json`), or one whose `fetch` throws (CORS, an odd scheme),
  is loaded by the engine at the swap instead.

**Interruption: latest wins.**

- A newer SEQUENCE takes over from the amount on screen, as soon as its two bodies are compiled
  (at once when they already are; until then the older one keeps playing). Mid-out, it keeps
  dispersing the same photo from where it is (no jump back); mid-in, it disperses the half-built
  one. The older call resolves; mid-out, its fetch is aborted and its next file never reaches the
  engine.
- A newer call of any OTHER transition loads its asset as usual, then ends the sequence, as it ends
  any transition in flight. Before the old photo is gone, the photo comes back whole for that
  transition to start from (a pop). After it is gone, the tile is empty and the newer call lands as
  a cut. An asset the older call was still loading is unloaded unseen.
- Nothing is left behind: the body is removed, and the older call's asset is released or unloaded.
  Unit tests pin each case on the fake engine (`test/splat-playcanvas.test.mjs` §13f).
- `remove()` mid-sequence does not throw. As with the other transitions, the pending `setSource`
  promise does not settle after `remove()`.

**Failure.** An HTTP error on the next file is known before the old photo goes (it comes back, and
`setSource` rejects). A file that fetches but does not DECODE fails after the old photo is gone:
`setSource` rejects and the tile stays empty until the next `setSource`.

**Diagnostics.** `?dxrdiag` records a sequence like any transition: `detail.transition` is
`'reassemble(assemble>assemble)'` (or `'sequence(<out>><in>)'`), `outgoing` is `'none (one
splat)'`, and the marks are `sequence`, `out-done`, `released`, `loaded`, `adopted` and `in-start`.
There is no overlay, so the frozen-image count is 0 by construction. `viewer._transitionState` is
`{ phase: 'out' | 'load' | 'beat' | 'in', raw }` and `viewer._transitionPath` is `'sequence'`.

**Measured** (headless Chrome 153, ANGLE Metal, M1 Pro, real GPU; a fake 2-view wall, 2560×720;
`ports_100_cam.sog` → `mg_tahoe_k100.sog` / `mg_family_k100.sog`, 1,179,648 gaussians each).
**This Mac was very busy** during every run (load average 50–260, and other agents' headless
Chromes on the same GPU), so the frame gaps below are pessimistic; compare the arms, not the ms.

- **One splat resident.** A stepped-clock run sampled every frame: at most 1 splat asset loaded,
  1 splat entity, 1 gsplat manager, 1,179,648 gaussians and 58.8 MB of GPU textures, which is the
  still photo's. At the swap: 0 assets and 40.5 MB (the old one gone), then 1 asset placed hidden.
  Six real-clock runs peaked the same. A live `crossfade` peaks at 2 assets, 2,359,296 gaussians
  and 131.6 MB; `resident: true` at 2 assets and 81.3 MB (the prepared one, in the dwell).
- **End state.** The last frame equals a plain `cut` to the same file: MAE 0.000, max 0, colour and
  alpha, both eyes.
- **Frames** (stepped clock, both eyes): out-mid, the empty swap, the new photo placed hidden
  (black: its first frames draw nothing), in-mid, done. Kept local (the bench photo shows real
  people). In mono, `reassemble` and the general form with `sweep`→`converge`, `converge`→`sweep`,
  `dissolve-in`→`dissolve-in`, `shimmer`→`shimmer` and `fade`→`fade` each peak at 1 asset and
  58.8 MB and end at MAE 0.000 against a `cut`. (`sweep`'s front is sized by the framing box, as
  its reveal's is: on a SHARP photo, whose box reaches far behind the subject, the visible picture
  goes in the last part of its span.)
- **Diag** (real clock, `prepareSource(src, { transition })` in the dwell, head moving, 3 runs
  per arm, 9 in all): frozen-image frames **0** and held frames **0** in every run. No shader was
  created inside the window, the page's first sequence included (its bodies were compiled by the
  prepare).
- **Long tasks.** With the default fetch-only prepare, the next file's decode and upload run at
  the swap: `released` → `loaded` took 270–600 ms, with one or two 50–110 ms main-thread tasks in
  it (the engine's own SOG load; the SDK's passes there are 4–20 ms each). All but one of them
  fell in the empty beat, when nothing is drawn; the other (72 ms) fell in an out phase, in the
  busiest run. With `resident: true`, 0 long tasks in 3 of 3 runs (one 64 ms task at the swap in an
  earlier batch, again while the new photo was placed hidden). A live `crossfade` in the same
  conditions showed 0–1 long tasks (68 ms) and frame gaps of 69–90 ms.
- **Timing.** From the call: out 1350 ms, then the empty stretch (`out-done` → `in-start`) 380–420
  ms with `resident: true` and 380–770 ms fetch-only (the beat is at least 300 ms; the load
  stretches it), then in 1350 ms: 3.1–3.9 s in all.

**Not tested:**

- On a tracked panel through the DisplayXR Browser's real weave, which is what the sequence is for.
- Windows and Android GPUs.
- Interruption on the real engine: each case is pinned on the fake engine only.
- A Streamed SOG (loaded by the engine at the swap, so the empty stretch waits for it), `.ply`, and
  `controls: 'page'`.
- A resize or a 2D↔3D switch mid-sequence (nothing is captured, so nothing is invalidated; not run).
- How the empty beat reads to a viewer on the panel, and whether 45 / 10 / 45 is the right split.


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
half. An index-paired `morph` transition was prototyped on this (the old photo's gaussian i
flying to the new photo's gaussian i). It worked, and pairs any two SHARP files, but it was
dropped on review, along with the texture-uniform path.

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

**Particle transitions** (unreleased, preview). `5e5c097e.mono.sog` (Tahoe) → `a36d278b.mono.sog` (a
bakery), both SHARP, 1,179,648 gaussians each. Headless, same harness; the clock is stepped, so
frames sit at exact t.

| Transition | Path | End vs `cut`: stereo L, R (colour, alpha, max px diff); mono | VRAM, MB: before / during / after (stereo; managers after) | Coincident eyes L vs R at 0.2 / 0.5 / 0.8: grey MAE (max diff, % px) | Cost, ms/frame, held at t = 0.5: stereo none → window; mono |
|---|---|---|---|---|---|
| swarm | render | 0.000, 0.000 (0, 0, 0); 0.000 | 58.8 / 131.6 / 58.8 (1) | 0.001 / 0.001 / 0.001 (1 / 2 / 1; 0.39 / 0.58 / 0.19 %) | 17.7 → 15.5; 7.8 → 7.7 |
| burst | render | 0.000, 0.000 (0, 0, 0); 0.000 | 58.8 / 131.6 / 58.8 (1) | 0.002 / 0.000 / 0.001 (2 / 1 / 1; 0.56 / 0.02 / 0.31 %) | 17.7 → 12.1; 7.9 → 6.2 |
| shimmer-cross | render | 0.000, 0.000 (0, 0, 0); 0.000 | 58.8 / 131.6 / 58.8 (1) | 0.002 / 0.005 / 0.001 (1 / 2 / 1; 0.47 / 1.35 / 0.31 %) | 17.7 → 13.8; 7.9 → 6.9 |
| dust | render | 0.000, 0.000 (0, 0, 0); 0.000 | 58.8 / 131.6 / 58.8 (1) | 0.001 / 0.001 / 0.001 (1 / 2 / 1; 0.37 / 0.44 / 0.18 %) | 17.7 → 12.8; 7.9 → 6.4 |

- Every run resolves its promise and leaves `effects()` empty.
- After the pre-warm and overlay changes, `crossfade` and `wavefront` (live), and `swarm` and
  `dust` through `prepareSource(src, { transition })`, still end at 0.000 in both eyes. VRAM is back
  to 58.8 MB.
- In mono, VRAM during the window is 124.6 MB.
- The coincident-eye residue is the particle reveals' raster rounding of sub-pixel dots (see above).
- The cost column is held at t = 0.5, a GPU-synced 30-frame batch. A window is cheaper than the
  still photo because in-flight gaussians are dots, or hidden.

**Pacing, as seen: a VISIBLE Chrome 153 window.** 120 Hz display, M1 Pro, real clock and real rAF,
`prepareSource` then `setSource` as in a slideshow, one configuration per browser launch. Each cell
is the rAF interval in ms, median / p95 / p99 / max, over the frames where the transition clock ran,
followed by the number of frames over 25 ms. For reference, a still photo is 8.3 / 9.5–10.2 /
10.3 / 10.4 in 2D and 15.5 / 18–20 / 21–26 / 23–32 in stereo.

| | 2D: entity path (first cut) | 2D: render time | Stereo: entity path | Stereo: render time | Stereo: render time + `prepareSource({ transition })` |
|---|---|---|---|---|---|
| swarm | 8.3 / 16.7 / 17.5 / 47.5, 1 | 8.3 / 10.1 / 15.3 / 16.6, 0 | 15.5 / 24.1 / 34.4 / 35.4, 5 | 16.6 / 24.6 / 30.9 / 32.6, 7 | 16.7 / 25.2 / 25.8 / 25.9, 9 (all ≤ 26) |
| burst | 8.3 / 16.7 / 18.2 / 18.7, 0 | 8.3 / 9.8 / 10.3 / 10.4, 0 | 16.4 / 23.9 / 33.7 / 35.9, 4 | 15.6 / 18.0 / 33.7 / 40.1, 2 | 14.9 / 22.5 / 25.0 / 25.0, 0 |
| shimmer-cross | 8.4 / 16.7 / 17.7 / 18.8, 0 | 8.3 / 10.0 / 10.4 / 32.9, 1 | 16.6 / 24.2 / 31.3 / 34.4, 4 | 16.0 / 18.1 / 25.2 / 25.5, 2 | (2D with pre-warm: 8.3 / 9.1 / 15.9 / 49.8, 1) |
| dust | 8.3 / 16.8 / 18.0 / 34.4, 2 | 8.3 / 9.6 / 10.3 / 55.1, 1 | 16.4 / 24.6 / 38.1 / 41.2, 8 | 16.1 / 18.4 / 33.3 / 49.8, 3 | (2D with pre-warm: 8.3 / 9.0 / 9.3 / 9.4, 0) |

Per frame during the window:

| | Entity path | Render time |
|---|---|---|
| Work-buffer rewrites | 2.0 | 0 |
| Sort requests | 2.0 | 0 |
| Sort results | 1.2, 3–8 ms of main thread | 0 |
| Heap churn | 250–375 KB/frame in 2D (12–16 GCs, 69–98 MB per window); 75 KB/frame in stereo | 30–60 KB/frame |

Without the pre-warm, the first transition of a kind blocked 35–50 ms on its program link. On a
variant the machine had never compiled, it blocked 190 + 260 ms. With `prepareSource({ transition })`
the link finishes in the dwell: no program is finalized inside the window (instrumented
`WebglShader.finalize`), and 0 new shaders are created by the transition.

For reference, 1.19.1's live `crossfade` / `wavefront` ran at about 40 Hz in stereo on this Mac:
median 25.6 ms over the whole window, 20 and 49 frames over 25 ms. The `wavefront` now draws about
one photo's worth; the `crossfade` still draws two. See
[Wavefront: one draw's worth](#wavefront-one-draws-worth).

These numbers come from a Mac that was also in use; the load average was 13–19 during the later
runs. Rows whose still-photo baseline had itself degraded were discarded and re-run. The rest
still vary by a frame or two between runs.

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
- The `wavefront` cull and render-time ridge: on the DisplayXR Browser's real weave, on Windows or
  Android GPUs, with more than 2 eye views (up to 4 are culled; beyond that both photos are drawn
  in full), and with a page's own tile effects active during the window.
- Pacing on a quiet machine: the `wavefront` / `crossfade` pacing tables above were measured under a load average of 11–95.
- Particle transitions:
  - on the DisplayXR Browser's real weave, and on Windows or Android GPUs;
  - with a page's own tile effects active at the same time (they share the chunk);
  - with `controls: 'page'`;
  - on streamed SOG;
  - on the entity-path fallback on a real engine without reachable managers (only the fake engine
    runs it).
- An intermittent 60–100 ms GPU-process stall about 100–150 ms into some stereo windows (0–1 per
  run). A trace shows one long `CommandBuffer::Flush` on the GPU main thread, with no JS task and
  no program link. It is not diagnosed; it may be a Metal pipeline-state build for the live
  camera's render-target format.

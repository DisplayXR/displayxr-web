# Layer display rig — stage objects through the display rig, on a photo's camera rig

Status: **design note + implementation** (branch `feat/layer-display-rig`). One decision is open
for David (§5).

## The ask

A photo slideshow app built on the PlayCanvas splat backend draws stage objects (a boot, a
tetromino stack, video frames, their reflections, an additive pool/glint) in its own PlayCanvas
layer, drawn after the photo splat. They read FLAT, because they render through the photo's
**camera rig** (`type:'camera'`, convergence + vertical FOV from the SOG camera block,
`metersToVirtual` 1). The app wants them ROUND — seen through the **display rig** (physical eyes
against the physical screen, real centimetres of pop-out) — without hiding the photo, without a
second full pass, and with `setViewRig` still declaring the photo's rig (the weave follows the
photo).

The project rule is *declare, never compute*: pages declare an `XR_DXR_view_rig` descriptor and
consume the runtime's render-ready views; no page- or SDK-side Kooima off-axis math. So the first
question is where display-rig views come from while the layer's declared rig is the photo's.

## (a) Does the platform already expose both view sets? — **No.**

- **One rig, one view set, per session.** Blink holds a single `inline_3d_scene_layer_` and chains
  *its* current rig on the one locate per frame (`XRSession::Inline3DViewRigForLocate`, browser
  patch 0124: "the session reads the SCENE layer's CURRENT rig at pull time"; "the view set is
  session-global (one viewer pose) … last scene layer wins"). The core hands the same
  `pose.views` to every scene window (`js/inline3d.js` `_frame`). A second `XRDisplayLayer` with a
  display rig would therefore *replace* the photo's rig, not add one.
- **No raw eye channel in JS.** The runtime has one (`XrViewDisplayRawDXR`: display-space eyes,
  plane pose, canvas rect — `XR_DXR_view_rig.h`), but no browser patch exposes it to script, and
  `XRDisplayInfo` (patch 0128) carries panel metres/pixels and view scale only — **not** the
  nominal viewer position.
- **`setRig('display')` and `setVideo` are re-declarations, not computations.** Both build a
  `displayRig({...})` descriptor and push it with `declareViewRig` (the whole layer switches rig;
  `js/inline3d-splat-playcanvas.js` `setRig`, `pushViewRig`, `setVideo`). Nothing in the SDK
  computes a display-rig view today.

## (b) Can the camera rig's views be mapped EXACTLY onto display-rig views? — **Yes, up to one scalar.**

### A camera rig *is* a portal

From the runtime's own math core (`displayxr-common`, `dxr_camera3d_compute_view`), camera-rig
view *i* has, in the declared camera frame (looking down −z, convergence distance `D = 1/invd`
world units, `m = metersToVirtual`, processed eye `p_i` in metres relative to the nominal viewer):

```
eye_i        = N0 + R·(m·p_i)                    (N0 = declared camera position)
tan_right_i  = (ro − m p_x/D) / (1 + m p_z/D)  =  (ro·D − m p_x) / (D + m p_z)
```

That is *exactly* an off-axis portal: a fixed window rectangle of half-extents `(ro·D, uo·D)`
centred at `Wc = N0 + D·fwd` (the convergence plane), seen from the eye. The runtime's own rig
conversion (`dxr_view_rig_display_to_camera` and its inverse) states the same thing at the
descriptor level: a camera rig with `m = 1` and factors 1 *is* the display rig with
`virtualDisplayHeight = 2·D·tan(vfov/2)`, `perspectiveFactor = tan(physFOV/2)/tan(vfov/2)`, pose
at the convergence plane, and **`ipdFactor = parallaxFactor = n/D`** (n = nominal viewer
distance). The photo is flat precisely because a lift's convergence `D` (metres of scene) is several
times the viewer's distance `n`, so the rig damps both factors by `n/D`.

The ROUND rig is the same display rig with `ipdFactor = parallaxFactor = 1`. The runtime applies
both factors linearly about the nominal viewpoint (`dxr_display3d_apply_eye_factors_n`), so its
eyes are the photo's eyes scaled about the declared camera position:

```
E'_i = N0 + k·(E_i − N0),     k = D / (m·n)
```

### Two portals through one window differ only by the eye — an exact identity

For a portal through a fixed window plane, the picture of a point `X` from eye `E'` equals the
picture of `M(X)` from eye `E`, where `M` is the affine shear that fixes the window plane pointwise
and sends `E'` to `E`:

```
M_i(X) = X + h(X) · (E_i − E'_i) / h(E'_i),      h(X) = (X − Wc)·ẑ,   ẑ = −fwd (toward the viewer)
```

Proof sketch: `M` is affine and fixes every point `w` of the plane, so it maps the ray
`w + t(E'−w)` to `w + t(E−w)` — every ray from `E'` through a window point onto the ray from `E`
through the same window point. So

```
view_round_i = view_photo_i · M_i          proj_round_i = proj_photo_i   (verbatim)
```

The runtime's projection matrix is used **unchanged**; no frustum, tangent or off-axis matrix is
built. The inputs are the runtime's `view.transform` (E_i), the descriptor *we* declared for that
locate (N0, fwd, D, m), and `k`. The shear is invertible (`det M = h(E)/h(E') > 0`), and it moves
depth only by a monotone remap along each view ray, so occlusion inside the layer is preserved.
It has the properties the requester asked for **by construction**:

- the convergence plane is fixed pointwise → the object's z = 0 contact point does not move, in
  any view;
- a single view (mono / 2D tier / 1-view mode) sits at `N0` → `E' = E` → `M = I` → identical to
  today;
- the 2D↔3D ramp scales the photo's factors; `E'` is defined from `E`, so the layer ramps with it;
- at the nominal viewer the layer's picture is the photo's picture: only stereo and head parallax
  change.

**The one scalar.** `k = D/(m·n)` needs `n`, the nominal viewer distance, which the runtime knows
(`nominalViewerPositionInDisplaySpace`) but the browser does not expose. The camera rig subtracts
`n` from every eye (`p = e − n·ẑ`), so it cannot be recovered from the views. Everything else in
the mapping is exact.

What "physical" means here: near the plane, disparity per unit depth equals the physical
display's (both the baseline and the distance are scaled by `k`), so pop-out is real centimetres
to first order; far from the plane the portal's perspective is the photo's, not a strict
`perspectiveFactor = 1` rig. The strict rig would put the viewer at `m2v·n` instead of `D` and so
draw the objects in a different perspective from the photo they stand in — and it needs the
absolute eye z, which is not exposed. Not chosen.

## (c) The platform follow-ups (not blocking)

1. **Expose the nominal viewer** in `XRDisplayInfo` (`nominalViewerDistanceMeters`, or the full
   `nominalViewerPosition`) — one field from `XrDisplayInfoDXR` that the browser already reads. It
   turns the §5 default into a runtime-provided value.
2. **Secondary rig per layer**: `XRDisplayLayer.setViewRig(rig, { secondary })` → the runtime
   computes both view sets from the **same eye sample** (a second `XrViewRig…` chained on the one
   locate, a second `XrView[]` on `XrViewState::next`), surfaced as `XRView.secondary` or
   `pose.secondaryViews`. Needed only if a layer ever wants a rig that is *not* a factor change of
   the declared one (another window, another vH).

Neither fits the Oct 2 date; the exact mapping above does not need them.

## Chosen approach

**`handle.setLayerRig(layer, 'display' | 'camera', { viewerDistance?, gain? })`** on the PlayCanvas
splat handle, plus the `addSplat` sugar `displayRigLayers: [...]`. It adds camera(s) that render
the named layers into the same render target, in composition order, with the photo's views
right-multiplied by `M_i`:

- The tile's layer composition is split into contiguous **runs**: the eye camera keeps everything
  before the first display layer, a `display` camera (priority 1) draws the display layers, and a
  `post` camera (priority 2) draws what came after them (UI: the edge feather and the transition
  overlay). Order is exactly today's; PlayCanvas orders render actions by camera, so one camera per
  run is what preserves it.
- The display camera clears **depth only** in 3D (the two camera spaces never share a depth test;
  the splat writes none), and nothing in mono (where the spaces coincide — identical to today).
- Same N `RenderView`s, same viewports, same XR properties as the eye camera; frustum culling off
  on the display camera (a few meshes; the sheared views are not a rigid frustum).
- The rig the views were located with is snapshotted at the top of each frame, before the tick
  can declare a new one (Blink chains the rig at pull time: one frame of latency).
- Identity when the declared rig is not a camera rig (`setRig('display')`, `setVideo`, an object
  splat), in mono, on the N-camera fallback view path (warned once), and under the kill switch.
- **Kill switch:** `?dxrdiag=nolayerrig` (or `diag:'nolayerrig'`): the layers stay on the eye
  camera, byte-for-byte today's path.
- `setViewRig` is untouched: the runtime keeps receiving the photo's rig.

## 5. Needs David's decision

**The default `viewerDistance` (n).** Default **0.6 m** (the browser's own `kNominalViewDistance`)
unless the page passes `viewerDistance` or an explicit `gain`. It is a gain, not an eye pose: a
wrong `n` scales the objects' depth by `n_true/n`, it never moves the contact plane or the mono
picture. Options: keep 0.6 m; require the page to pass it; or land follow-up 1 and read it.

## Stereo side-by-side on a stage quad (`handle.makeSbsMaterial`)

The same PR adds per-eye SBS sampling on an arbitrary quad (the app's call / trailer previews).
The eye is picked in the fragment shader exactly as `setVideo`'s plane does it: the eye viewports
sit side by side in the buffer, so `gl_FragCoord.x ≥ split` is the right eye; the SDK publishes the
split as a **scene-wide uniform** `dxr_eye_split` every draw (`1e9` in mono/2D/1-view: every
fragment samples the left half). This works on both view paths; PlayCanvas's own `view_index`
uniform is also set per view on the RenderView path, but is 0 for every camera on the N-camera
fallback, which is why it is not used. The quad's geometry stays where the app put it (z = 0);
the clip's disparity lives in the frame. The SDK decodes nothing — the app's one `<video>` feeds
one texture.

## Addendum (after 1.24): the panel report, both view paths, the plane offset

**Report.** On the panel the layers looked flat, "as if rendered by the splat camera", and
recessed. 1.23 could not engage for three reasons, all silent or nearly so. First, a layer the
tile's eye camera does not draw: a page's own camera, or no camera at all. Second, the N-camera
fallback path, which gave one console warning at the call. Third, a declared rig that is not a
camera rig. `layerRigState()` reported `rounded:false` for all of these and in mono alike.
Now `layerRigState()` reports `path`, `engaged` and `reason`, and WARNs them on the first 3D frame.

**Which path the browser takes.** `pickViewPath(pc)` alone decides it: the RenderView path whenever
the engine module exports `RenderView` and `Camera.prototype` has `xrViews` (PlayCanvas ≥ 2.x; the
SDK's own `inline3d-playcanvas-engine.js` exports both), unless the page forces
`playcanvasViewPath: 'cameras'`. It depends on neither the view count nor the transition / live
outgoing paths (the live outgoing *requires* the RenderView path). The 1.23 harness used the same
engine module, so it took the same path. What it did not exercise was a layer drawn by a camera
other than the eye camera, and the N-camera path. Both are now covered, and the harness runs all
of path × controls. On the N-camera path `handle.engine.camera` is null, so a page that adds its
layer with `handle.engine.camera.camera.layers = …` would throw there. A page that got past that
line is on the RenderView path.

**1.24's rig map.** The layer camera gets the views the photo is drawn with. When the rig map
remaps them (a declaration in flight), it gets them together with the rig they were remapped *to*.
Otherwise it gets the rig they were *located for* (read off the views), with the SDK's snapshot as
the fallback (`located` in the state says which). So the layer rig always uses the frame's source
rig, never a rig the views were not built for.

**Plane offset.** Given a plane at distance D′ from the photo camera N0 that should land on the
glass, let S be the uniform scale about N0 by σ = D/D′. S maps the window at D′ onto the photo's
window at D, and it maps every ray from N0 onto itself.
Then `view_round = view_photo · M_i · S` is exactly the display rig through the window at D′,
with factors 1: portal(W_D′, E″) = portal(W_D, S(E″)) ∘ S, and S(E″) = N0 + k(E − N0) is the
original round eye, so M_i is unchanged. At the nominal eye both S and M_i leave the picture where
it was, so the 2D image does not move. `planeOffset` (panel metres toward the viewer) maps to
D′ = D(1 + planeOffset/n), because near the plane the round rig maps world depth to panel depth at n/D.
Unit test: max NDC error < 1e-9 against the oracle display rig at D′.

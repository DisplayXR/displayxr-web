# Porting an existing three.js app (WebXR or plain) to inline 3D

You have a three.js app. Maybe it already does headset VR through `renderer.xr` and a `VRButton`;
maybe it is a flat page that never heard of WebXR. Either way, making it render glasses-free 3D on
a DisplayXR display is a **small, local change** — and the reason it is small is worth stating up
front, because it is what makes the port tractable: inline-3D does not ask your app to become an XR
app. It asks for two renders instead of one, from cameras the runtime hands you, into the two
halves of a canvas.

Nothing about your world model changes. That is the opposite of the headset port you may remember,
where the reference space, the locomotion model and the input model all had to be rebuilt.

This page is the mapping. Read [`authoring-inline-3d.md`](authoring-inline-3d.md) for the rules
behind it — this one assumes them and points at them.

## 1. What changes and what does not

**Stays exactly as it is:**

- your scene graph, materials, lights, loaders, assets;
- your controls — keyboard, mouse, touch, pointer events on the canvas;
- physics, animation, audio, networking, state;
- your DOM UI. Menus, HUDs, buttons, dialogs stay DOM, and they stay *good* — see
  [§6](#6-dom-ui-over-the-woven-canvas);
- your camera. You keep it, you keep driving it, and on a camera rig you keep its framing.

**Changes:**

1. **The render call becomes two.** One `renderer.render(scene, camera)` per frame becomes one per
   eye, into a viewport the session reports.
2. **The camera becomes per-eye at draw time only.** Your app camera is still the camera; two
   `EyeCamera`s carry the runtime's off-axis projection and eye pose for the two draws.
3. **The canvas backing store becomes double-width.** Left eye in the left half, right in the right
   ([the one contract](authoring-inline-3d.md#the-one-contract-you-must-understand)).
4. **The loop is driven by the SDK.** `onFrame(views, layer)` runs on the session's animation
   frames instead of your `requestAnimationFrame` / `setAnimationLoop`. You keep the flat loop for
   the fallback path; you do not run both.

**Headset VR and inline-3D are mutually exclusive, and the cleanest way to enforce that is not to
build the other one.** Detect inline-3D during init, and where it is supported skip your XR setup
entirely — no `VRButton`, no controllers, no hands, no `renderer.xr.enabled`. A branch this early
costs one `await` (it resolves in milliseconds when it resolves at all) and removes a whole class
of "which session owns the renderer" bug from the rest of the app.

**One `createInline3D()` per document.** Not per canvas, per renderer or per route component — per
*document*. The browser's element-rect channel is a whole-widget setter, so two live managers
overwrite each other's rect list every frame and tiles flicker, ghost or weave at a stale rect. The
SDK warns, but it cannot fix it. If your app has a second three.js renderer somewhere (a minimap, a
preview thumbnail, a component library), it must not open its own session — add its canvas to the
same `wall`, or leave it flat. Sequential sessions across routes are fine: `wall.close()` the old
one first.

## 2. WebXR → inline-3d

If your app has an `immersive-vr` path, this table is the port. If it does not, read the right-hand
column as the shopping list.

| WebXR | inline-3d | Why |
|---|---|---|
| `navigator.xr.isSessionSupported('immersive-vr')`, `VRButton` | `await createInline3D()`, then `wall.supported`. `inline3DAvailable()` for a cheap synchronous pre-gate | **Never** `isSessionSupported('inline-3d')`: it is an async round-trip to the OS weave service and resolves `false` if it runs before the service has bound — typically at page load. A false negative that silently ships 2D to a capable machine. `createInline3D` detects by *acquiring* a session, which is authoritative. |
| A button the user presses to enter | Nothing. The page is already in 3D | There is no immersion to enter and no permission to grant — the element is woven where it sits, inside the page, from the first frame. Any "enter 3D" affordance you keep is decoration. |
| `renderer.xr.enabled = true`, `renderer.xr.setSession(...)` | Never touch `renderer.xr` | inline-3D does not go through three's WebXR manager at all: it hands you matrices and you render. Leaving `xr.enabled` on is actively harmful — it changes three's render path, and third-party code branches on `renderer.xr.isPresenting` ([§5](#5-gaussian-splats-spark)). **`immersive-vr` and `inline-3d` must not share a renderer.** If your app supports both, give the headset path its own `WebGLRenderer` and canvas, and never have both live. |
| `renderer.setAnimationLoop(fn)` | Keep it for the **mono** path; the SDK's `onFrame` drives the woven path | The session runs its own animation frames. Running both means two updates and two renders per frame, and the flat one draws a mono image over your SBS buffer. Call `renderer.setAnimationLoop(null)` when the tile goes live. |
| `XRWebGLLayer`, `session.renderState.baseLayer.framebuffer`, `getViewport(view)` on it | Your own canvas. `renderer.setPixelRatio(1)`, a double-width backing store, and per-eye `renderer.setViewport` / `setScissor` from `layer.getViewport(view)` | There is no runtime-owned framebuffer here — the woven window *is* your canvas, and its buffer is the SBS pair. `getViewport()` reports **backing-store pixels**, but three multiplies `setViewport`/`setScissor` by the renderer's pixel ratio, so any ratio but 1 silently scales each eye. It fails deceptively: the scene still head-tracks perfectly, it is just zoomed and off-centre, so it reads as a projection bug. |
| `requestReferenceSpace('local-floor' \| 'local' \| 'bounded-floor')` | None. There is one space and you never ask for it | The canvas plane is world `z = 0` and the viewer is a few tens of cm in front of it. There is no room, no floor and no origin to negotiate. |
| Locomotion by `getOffsetReferenceSpace(new XRRigidTransform(...).inverse)` — teleport, snap-turn, smooth locomotion | Move your camera | This is the single biggest simplification. Offset reference spaces exist because in a headset you cannot move the user's head, so you move the world under it. Here the "user" is a viewer sitting at a desk: the app camera is the viewpoint, you move it the way you did before WebXR, and you tell the runtime where it went with a **view rig**. Delete the rig object, the offset space, and the inverse-transform bookkeeping. |
| `renderer.xr.getCamera()` → an `ArrayCamera` of two sub-cameras | Two `EyeCamera`s from `@displayxr/inline3d/three` | Same idea, explicit. `EyeCamera` has `matrixAutoUpdate` off and takes `projectionMatrix` + `transform.matrix` straight off the `XRView` — `setFromView` for a world pose, `setLocalFromView` for the [attach pattern](#the-attach-pattern-and-the-frame-of-lag). |
| Controllers, hands, `XRInputSource`, `squeeze`/`select` events, gesture detection, haptics | None. Keyboard, mouse, touch, pointer events — exactly as on the flat page | An inline-3D session is **sensorless** apart from the eye tracking that drives the weave. There are no input sources to enumerate and no `inputsourceschange` to listen for. Everything that was gated on a controller needs a DOM-input equivalent, and everything you already had on the flat page still works because the canvas is still a normal element receiving normal events. |
| `session.updateRenderState({ depthNear, depthFar })` | The same call, on `wall.session` | Unchanged, and still worth making: `XRView.projectionMatrix` is built with the session's near/far, so leaving them at the defaults while your app camera uses `0.05 / 100` gives every eye a different depth range than the one your scene was tuned for. Set them from your camera once the session is up, and again if you change them. |
| Foveation, `framebufferScaleFactor` | Scale the **backing store** yourself | See [§4](#resize-and-quality-scaling). There is no runtime-owned framebuffer to ask for a scale factor; there is your canvas, and you choose how many device pixels it holds. |

## 3. Declare the rig, never compute it

The thing to *not* do, on any of these paths, is compute stereo yourself. A ported app usually
arrives with an instinct to offset two cameras by an IPD and shear their frustums — and there is a
correct way to do that, the off-axis (Kooima) construction, which is exactly why you should not
write it. **The runtime already computes it**, from the real eye positions its tracker reports,
against the real physical geometry of the element on the real panel — none of which the page knows.
An app that re-derives the frustum is guessing at three numbers it cannot measure, and it gets a
result that does not match what the native apps on the same display produce.

So the page's job is to **declare a rig** and consume render-ready views. This is the web spelling
of the runtime's `XR_DXR_view_rig` extension and the decision behind it,
[ADR-024: Raw vs Render-Ready Views](https://github.com/DisplayXR/displayxr-runtime/blob/main/docs/adr/ADR-024-raw-vs-render-ready-views.md)
— every DisplayXR app used to carry its own copy of the same math, and none of them needed to. The
SDK holds that line too: `cameraRigFromCamera()` and `displayRig()` fill in a descriptor and
compute nothing.

### Which rig

- **Display rig** — *the canvas is a portal.* Its plane is `z = 0`, the viewer looks through it at
  a virtual display `virtualDisplayHeight` metres tall. Pick this when the element frames a
  **subject**, not a viewpoint: a product viewer, a photo, a hero object, a portal into a diorama.
  You author at a fixed scale for a fixed window; you have no camera to hand over, and inventing
  one buys nothing.
- **Camera rig** — *the app has a camera; perturb its frustum.* You send pose, vertical FOV and a
  convergence distance; the runtime keeps your framing, offsets the eyes and skews each frustum so
  the convergence distance lands on the zero-disparity plane. Pick this whenever the app **owns a
  viewpoint the user moves**: an orbit, a walkthrough, a game, a map, an editor. A display rig
  cannot express it at all — a portal has no camera to follow you.

A ported WebXR app is nearly always the second case, because a WebXR app has a camera by
construction.

### The fields you will actually set

The full table is in [authoring](authoring-inline-3d.md#the-fields). For a camera rig, three:

```js
cameraRigFromCamera(THREE, appCam, {
  convergence: 1.2,   // WORLD units. Where content sits ON the glass. The one to get right.
  attach: true,       // emit an identity pose; see below
  out: rigScratch,    // reuse the descriptor object — a per-frame call should allocate nothing
});
// verticalFov comes from appCam.fov (degrees → radians for you); the pose is decomposed from
// appCam.matrixWorld, not read off .position/.quaternion, so a camera parented under a dolly
// still reports a pose in the right space.
```

**Convergence is what your app knows and the runtime does not.** Point it at whatever the viewer is
meant to be looking at:

- an **orbit / third-person** camera → the orbit target distance. If the user zooms, convergence
  follows, and the subject stays welded to the glass while the framing changes around it.
- a **first-person** camera → a fixed look-ahead, a couple of metres. Not the distance to whatever
  the crosshair happens to be on: hit-testing convergence to a moving surface makes the whole scene
  breathe in depth every time you sweep the view, which is far more uncomfortable than a slightly
  wrong constant.
- left at `0` it means **infinity**, which puts the entire scene in front of the display. That is
  comfortable for almost nothing, and it is the default, so set it.

An app with two camera modes needs a policy, not a constant. A worked one:

```js
function convergenceDistance() {
  const live = () => camera.position.distanceTo(orbitTarget);
  if (isCameraTransitioning) return live();          // eases with the camera instead of jumping
  if (cameraMode === 'first-person') return 3.0;     // fixed: the orbit target is the viewer's OWN
  return live();                                     //   head, so the live distance would be ~0
}
```

Three decisions in six lines, and each is the interesting one. Third person uses the live
camera-to-subject distance, so the character sits on the glass and the terrain falls away behind
it. First person **cannot** use it — the target is the viewer's own head and converges at nothing —
so it takes a fixed comfortable look-ahead. And during the transition between the two, the live
distance is used in *both* directions deliberately: it lerps with the camera, so convergence eases
across the cut instead of snapping the whole scene through the glass in one frame.

### The attach pattern, and the frame of lag

**The browser locates views BEFORE the page's rAF.** A rig you set during frame N drives the views
delivered in frame N+1. On a slider or a settled camera that is invisible. On a camera whipping
around under the pointer it is not — the stereo trails the render by a frame, and it reads as a
soft, swimming misalignment rather than as lag, which makes it hard to diagnose and impossible to
ignore.

Do **not** predict the camera forward. Send an identity-posed rig and let three's scene graph
compose this frame's world pose:

```js
scene.add(appCam);                            // IN the scene: three only reaches a parented
for (const e of eyes) appCam.add(e.camera);   // camera through a traversal

handle.setViewRig(cameraRigFromCamera(THREE, appCam, { attach: true, convergence, out: rig }));
eyes[i].setLocalFromView(views[i]);           // LOCAL, because the eye is parented
```

That is a scene-graph parent and nothing else. The projection matrix is still the runtime's and the
local transform is still the eye pose it reported — read in rig space instead of world space, which
is exactly what an identity pose means. The runtime keeps the part it is uniquely good at; the app
supplies the part it knows first.

Two things bite. `renderer.render(scene, camera)` only auto-updates a camera whose `parent` is
`null`, so a parented eye camera must be reached by a normal `scene.updateMatrixWorld()` — keep the
app camera **in the scene**. And the parenting and the setter are one decision: `setLocalFromView`
with an unparented eye renders from the origin; `setFromView` with a parented one applies the
camera's transform twice. Flip them together, in one function, or you will flip one of them alone.

### Comfort

The runtime's own rule:

```
ipdFactor × metersToVirtual × convergenceDiopters × N ≤ 1        (N ≈ 0.5 m, nominal viewing distance)
```

At `1` the viewer's eyes are parallel on infinitely distant content; **past 1 they diverge**, and
nobody can fuse that. With a camera rig's defaults (`ipdFactor` 1, `metersToVirtual` 1) it reduces
to *keep convergence past about 0.5 world units*.

Which is why **the units your scene is authored in are now load-bearing**. On a camera rig
`ipdFactor` and `metersToVirtual` are **absolute**, in your world units — a scene built in
centimetres, or in "1 unit = 1 tile", sails past the comfort limit at every plausible convergence
and there is no clue in the code that anything is wrong. Either author at metre scale, or set
`metersToVirtual` to your units-per-metre and leave it there. Nothing in the SDK enforces the rule
(the runtime clamps its own inputs, once, with a warning); `samples/camera-rig/` prints it live, and
is the fastest way to develop an intuition for it.

### Capability gate and fallback

```js
import { inline3dViewRigSupported } from '@displayxr/inline3d';
if (inline3dViewRigSupported()) { /* rigs are available */ }
```

It reads a capability — the presence of `XRDisplayLayer.prototype.setViewRig` — never a version or
a UA string. On a browser without it, `setViewRig()` warns once and returns `false`, `addScene`'s
`viewRig` is ignored, and **the window still weaves** on the runtime's default display rig. So call
it unconditionally; branch only if your framing genuinely depends on the rig — which for a camera
rig it does, since the fallback frames by `virtualDisplayHeight` rather than by your camera. Name
that fallback framing yourself:

```js
wall.addScene(canvas, onFrame, {
  virtualDisplayHeight: 0.24,                                    // what an older browser will use
  viewRig: cameraRigFromCamera(THREE, appCam, { convergence }),  // wins where supported
});
```

(That combination warns once — the two describe the same slot — so pass both only where the
fallback framing is the point, which for a ported app it usually is.)

## 4. The render loop

The whole port, in one piece. Everything above is why one of these lines is the way it is.

```js
import * as THREE from 'three';
import { createInline3D } from '@displayxr/inline3d';
import { EyeCamera, cameraRigFromCamera } from '@displayxr/inline3d/three';

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(1);          // getViewport() is ALREADY backing-store px (see §2)
renderer.autoClear = false;         // one clear per frame, then N eye viewports
renderer.xr.enabled = false;        // inline-3d never goes through three's XR manager

scene.add(appCam);                                        // parented eyes need a traversal
const eyes = [new EyeCamera(THREE), new EyeCamera(THREE)];
for (const e of eyes) appCam.add(e.camera);
const rig = {};                                           // reused: a per-frame rig allocates nothing
const good = [0, 1].map(() => ({ proj: new Float32Array(16), pose: new Float32Array(16),
                                 x: 0, y: 0, width: 0, height: 0 }));
let haveGood = false;

const wall = await createInline3D({ lazy: false });
if (!wall.supported) { renderer.setAnimationLoop(monoTick); return; }   // your existing flat loop
sizeSBS();                                                             // 2x width, device px
wall.session.updateRenderState({ depthNear: appCam.near, depthFar: appCam.far });
const handle = wall.addScene(canvas, onFrame, {
  virtualDisplayHeight: 0.24,                                          // older browsers' framing
  viewRig: cameraRigFromCamera(THREE, appCam, { convergence: orbitRadius, attach: true, out: rig }),
});

function onFrame(views, layer) {
  update(clock.getDelta());          // YOUR app: input, physics, animation, camera — unchanged
  // Pushed BEFORE the gate on purpose: a rig drives the NEXT locate, so a frame that cannot draw
  // must still advance it — otherwise one hitch freezes the stereo as well as the picture.
  handle.setViewRig(cameraRigFromCamera(THREE, appCam,
    { convergence: convergenceDistance(), attach: true, out: rig }));

  // Validate EVERYTHING before clear(). Under load the session hands back a short view list or a
  // null viewport; neither throws, and clearing on such a frame is the black blink (web#12).
  if (!views || views.length < 2 || !layer) return replayLastGood();
  const vps = views.map((v) => layer.getViewport(v));
  if (vps.some((vp) => !vp || vp.width <= 0 || vp.height <= 0)) return replayLastGood();

  renderer.clear();                  // the point of no return
  renderer.setScissorTest(true);
  for (let i = 0; i < 2; i++) {
    const vp = vps[i], g = good[i];
    renderer.setViewport(vp.x, vp.y, vp.width, vp.height);
    renderer.setScissor(vp.x, vp.y, vp.width, vp.height);
    eyes[i].setLocalFromView(views[i]);          // LOCAL: parented under appCam (attach pattern)
    renderer.render(scene, eyes[i].camera);
    // COPIES, never the XRView: it is valid only inside this callback, and its matrices are live
    // views onto memory the UA recycles.
    g.proj.set(views[i].projectionMatrix); g.pose.set(views[i].transform.matrix);
    g.x = vp.x; g.y = vp.y; g.width = vp.width; g.height = vp.height;
  }
  renderer.setScissorTest(false);
  haveGood = true;
}

function replayLastGood() {
  if (!haveGood) return;             // before the first good frame do NOTHING — not even clear
  renderer.clear();
  renderer.setScissorTest(true);
  for (let i = 0; i < 2; i++) {
    const g = good[i];
    renderer.setViewport(g.x, g.y, g.width, g.height);
    renderer.setScissor(g.x, g.y, g.width, g.height);
    eyes[i].setLocalFromMatrices(g.proj, g.pose);
    renderer.render(scene, eyes[i].camera);
  }
  renderer.setScissorTest(false);
}
```

**Never skip a frame.** The weave reads each window's composited canvas every frame, and a canvas
that isn't redrawn can drop out of the aggregated frame, leaving a stale sub-rect that smears. So a
frame that cannot draw stereo **repaints the last good one** instead of returning early. A
one-frame-stale eye pose is imperceptible; a black frame and a smear are not. The state you replay
from must be a **copy** of the two matrices per eye — hold the `XRView` and the replay reads
whatever the next frame wrote into that memory, which is a worse bug than the blink.

Note the two halves of the validation are different in kind: `views.length < 2` is the session's
per-frame **mono fallback** under load, `getViewport()` returning null is a layer that is not
currently weaving. Both mean *this frame cannot fill the buffer*, so neither may empty it.
`handle.stats()` returns `{ frames, monoFrames }` if you want to see how often the first one fires
on real hardware.

If you would rather not own any of this: `@displayxr/inline3d/viewer`'s `SceneViewer` implements
exactly the loop above — validation, replay, resize and the mono fallback — and `./splat` and
`./model` are thin wrappers over it. It is an experimental subpath (see
[sdk-stability](sdk-stability.md)), so it is a choice, not the default advice; the loop above is
sixty lines and yours.

**The depth range is not a one-shot.** `updateRenderState({depthNear, depthFar})` at setup is right
only if your camera's clip planes never move — and they usually do, once: an app that sizes `far`
from a loaded model's bounds changes it several seconds after the session opened. Call it from the
loop behind a cheap guard (`if (near === lastNear && far === lastFar) return;`) so it follows the
camera without costing anything, and wrap it — a session mid-teardown throws, and the next frame
either works or ends.

**Never call `updateProjectionMatrix()` on an eye camera.** `EyeCamera` writes `projectionMatrix`
directly from the view; recomputing it from `fov`/`aspect`/`near`/`far` throws away the runtime's
off-axis frustum and replaces it with a symmetric one. The stereo then looks *nearly* right — both
eyes still move — which is the worst kind of wrong. Set `near`/`far` as plain scalars when
something needs to read them ([§5](#5-gaussian-splats-spark)) and leave the matrix alone.

### If your app already has an `animate()`

Do not move your frame logic into `onFrame`. The better shape — and the one that makes the port a
diff rather than a rewrite — is to let `onFrame` **stash the views and call the `animate()` you
already have**, and to branch only at the one line that actually draws:

```js
function renderFrame() {                    // animate() ends with this instead of render()
  if (dxr && dxr.active) dxr.renderStereo();
  else renderer.render(scene, camera);
}
```
```js
handle = wall.addScene(el, (views, layer, frame) => {
  this._views = views; this._layer = layer; this._frame = frame;
  try { onAnimate(); }                      // your existing animate(), completely unchanged
  finally { this._views = this._layer = this._frame = null; }
});
```

Everything above `renderFrame()` — delta time, input, physics, animation mixers, networking, your
adaptive quality system — runs identically in both modes and needs no `if`. The `finally` matters:
an `XRView` is valid only inside the callback that delivered it, so dropping the references at the
end guarantees a stray later read cannot see recycled memory rather than merely being unlikely to.

Two ordering rules around the swap:

- **`renderer.setAnimationLoop(null)` only after activation succeeded.** If `addScene` or the
  renderer setup throws, the app must still be on its own loop — restore the renderer, return
  `false`, and leave `setAnimationLoop` alone. An activation that half-succeeded and stopped the
  loop is a black page.
- **Activate after any full-bleed splash is `display:none`,** not before, and not on the same tick
  as an opacity fade ([§6](#6-dom-ui-over-the-woven-canvas)). Between `addScene()` and
  `setAnimationLoop(null)` the app is briefly driven by both loops; that is one frame of double
  update, which is fine, and it is the only reason to keep those two calls adjacent.

### Resize and quality scaling

```js
function sizeSBS() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr * renderScale);
  const h = Math.round(canvas.clientHeight * dpr * renderScale);
  const bufW = woven ? w * 2 : w;                       // DOUBLE-WIDTH while woven, 1:1 in mono
  const el = renderer.domElement;
  if (el.width === bufW && el.height === h) return;     // observer fired, geometry didn't move
  renderer.setSize(bufW, h, false);
  appCam.aspect = w / h; appCam.updateProjectionMatrix();
  replayLastGood();                                     // repaint NOW, not next frame
}
```

Two rules, both learned the same way:

- **`setSize` clears the buffer even when nothing changed.** It writes `canvas.width`/`canvas.height`
  unconditionally, and writing either reallocates and clears the drawing buffer even for an
  identical value. A `ResizeObserver` fires on plenty of things that leave the dimensions exactly
  where they were — a sub-pixel reflow, a scrollbar appearing and going, a sibling settling — and
  its callback runs *after* rAF and *before* paint, so a no-op resize commits one black frame with
  nothing on the way to repaint it. Compare first; and when it genuinely changed, repaint
  **immediately**.
- **A quality/adaptive system must scale the backing store, never the pixel ratio.** The
  `renderScale` above is a multiplier on the number of device pixels you allocate. Reaching for
  `renderer.setPixelRatio()` instead is the same trap as §2: it rescales every `setViewport` call
  and misplaces both eyes, while still head-tracking perfectly.

  An existing quality system that owns `setPixelRatio` is redirected in two lines rather than
  rewritten — give it a hook and let the caller decide where the number goes:

  ```js
  // in the quality system, replacing the direct call
  if (this.onPixelRatio) this.onPixelRatio(targetPixelRatio);
  else this.renderer.setPixelRatio(targetPixelRatio);
  ```
  ```js
  // when the tile goes live: the system asks for min(deviceRatioCap, preset.pixelRatio), so
  // dividing by the cap gives 1.0 at the top preset and ~0.5 at the bottom on a 2x display.
  const cap = Math.min(window.devicePixelRatio || 1, 2);
  quality.onPixelRatio = (target) => setRenderScale(target / cap);
  ```

  Floor the result around **0.5**. Below that the eye halves are resolving fewer pixels than the
  panel's lens pitch needs and the interlace itself becomes visible — a failure mode a flat page
  does not have, so a quality ladder tuned on 2D will happily walk past it.

## 5. Gaussian splats (Spark)

Splats are the one content type where "render twice" is not free, because a splat renderer sorts.

**Spark decides its sort per `render()` call**, keyed on `renderer.info.render.frame` — which
increments per render, not per animation frame. So a stereo frame is two renders and buys **two
full sorts**, doubling the most expensive thing in the pipeline. The eyes are ~63 mm apart; that
does not meaningfully change back-to-front order for a tabletop-sized subject, so one sort per
frame is the right trade:

```js
// Spark >= 2 — throttle the sort. 16 ms ≈ one sort per frame at 60 Hz, whatever the eye count.
const spark = new SparkRenderer({ renderer, minSortIntervalMs: 16 });
scene.add(spark);
```

```js
// Spark 0.1.x — no throttle, so drive it by hand: sort ONCE, from the APP camera, before the eyes.
const spark = new SparkRenderer({ renderer, autoUpdate: false });
spark.update({ scene, viewToWorld: appCam.matrixWorld });   // once per frame, not per eye
```

The app camera is the right viewpoint for that single sort for the same reason one sort suffices:
it sits between the eyes.

Two more, both quiet failures:

- **The eye cameras must carry real `near` / `far`.** `EyeCamera` writes `projectionMatrix`
  directly, so `camera.near` and `camera.far` keep `PerspectiveCamera`'s defaults — and Spark reads
  them as **uniforms**, not from the matrix. Left alone they fight the projection and splats cull or
  band at the wrong depths. Set them to the same values you gave `updateRenderState`:
  ```js
  for (const e of eyes) { e.camera.near = appCam.near; e.camera.far = appCam.far; }
  ```
- **Keep `renderer.xr.enabled` false.** Spark has an `isPresenting` branch that assumes three's
  WebXR camera plumbing; on inline-3D that plumbing is not there and the branch renders from a
  camera you never set. This is the concrete cost of the "never touch `renderer.xr`" rule in §2 —
  the flag is read by libraries you did not write.

Beyond that a splat scene ports like any other: `@displayxr/inline3d/splat`'s `addSplat()` wires all
of the above plus framing and the mono fallback, if you would rather not.

**Spark is the instance, not the rule.** Generalise it: *anything that keys work off
`renderer.info.render.frame`, or hangs it on `onBeforeRender`, double-fires on the stereo path* —
that counter increments per **render**, not per animation frame, and you now render twice. Sorters,
reflection probes, shadow-cascade updates, CPU culling passes, "once per frame" analytics, any
`onBeforeRender` that mutates state rather than only reading it. The fix is always the same shape:
turn the library's auto-update off, hoist its per-frame work above the eye loop, and drive it once
from the **app** camera, which sits between the eyes and is the right viewpoint for a decision both
of them share. Audit your dependencies for this before you profile — a doubled sort reads as "the
display is slow", not as "I render twice now".

## 6. DOM UI over the woven canvas

Keep your HUD in DOM. This is not a compromise — it is better here than it was in the headset.

**DOM is at the display plane by construction.** It is drawn by the browser at the panel's native
resolution with zero disparity, so it is *crisp* (no per-eye resampling, no stereo blur), it sits
exactly on the glass where text is comfortable to read, and it hit-tests like ordinary HTML. Every
reason a headset app had to build its world-space UI out of quads and raycast a laser pointer at it
is gone. A ported app should **delete** that machinery, not port it.

On a browser with draw-order occlusion your 2D already composites over the woven tiles per-pixel,
by CSS stacking order, with nothing declared. On older DisplayXR Browsers the SDK's exclusion
machinery does it, and the rules there are stricter — the full story, both generations, is in
[2D over 3D](authoring-inline-3d.md#2d-over-3d--draw-order-occlusion). What a ported app needs to
know:

- **Partial-rect elements over the canvas are fine.** A crosshair, a score plate, a minimap corner,
  a toolbar, a bottom scrim. Register them with `wall.addGlobalOverlay(el)` — required on a browser
  without draw-order occlusion, accepted and ignored on one that has it, so the call is
  unconditional and cheap and you never branch on a version. An app
  whose HUD is its own elements rather than page furniture is better off with
  `createInline3D({ autoChrome: false })` and an explicit list: the automatic scan looks for
  `fixed`/`sticky` elements in the top three DOM levels, which is what a *site* looks like, not
  what a game's HUD looks like — and an explicit list is a place where the full-bleed rule below
  can be enforced by review.
- **A full-bleed element sharing the canvas's rect breaks the weave match.** Start screens, pause
  modals, loading overlays, full-screen scrims — the exact things a game has. On the legacy path the
  browser matches an excluded element's rect to a composited quad, and an element covering the whole
  canvas matches **the canvas's own** quad: the canvas is then staged as the overlay, leaves the
  weave input, and the tile presents its raw side-by-side buffer — two squished halves, no 3D. It
  looks catastrophic and it is silent.

  So a full-bleed element must be **hidden with `display:none`, never `opacity:0` or
  `visibility:hidden`** — only `display:none` reports an empty rect; an invisible element is still
  *there* and still measured — and it must be `display:none` **before** you register the tile. A
  start screen that fades out on `opacity` and a start screen that is `display:none` are the same
  picture and different weaves.
- **No `backdrop-filter`** on anything that overlaps a tile, on either generation. It is by
  definition a function of what is behind it, and what is behind it is the lens-interleaved buffer.
  A near-solid background (`rgba(16,17,22,.92)`) reads much like a frosted panel.
- **Never animate the canvas's own transform or size.** Not `transform: scale()`, not a width
  transition, not a CSS `filter`. A woven tile's rect reaches the compositor once per frame and the
  weave is computed for *that* rect; animate the element and the two disagree for the length of the
  animation. Animate a wrapper, a sibling, or the content inside the buffer instead — the recipes
  are in [Motion, transitions and per-eye effects](authoring-motion-and-effects.md).

## 7. Picking and pointer lock

**Raycasting is unchanged, on a camera rig.** The rig preserves your app camera's framing — that is
its whole definition — so the frustum your mouse coordinates were normalised against is still the
right one:

```js
raycaster.setFromCamera(mouse, appCam);     // the APP camera, never an eye camera
```

Do not pick against `eyes[i].camera`. Each eye is offset and sheared; a hit tested against one of
them is wrong by half an IPD, and by different amounts near and far. There is exactly one cursor on
one screen, so there is exactly one camera it belongs to.

On a **display rig** there is no app camera to raycast from, and picking has to go through the
element's own geometry: treat the canvas as the `z = 0` plane and map the pointer onto it. That is
the other reason an interactive ported app usually wants a camera rig.

**Pointer Lock over a woven canvas is unverified on hardware.** Locking the pointer and reading
`movementX/movementY` is the standard first-person control scheme, and nothing about it obviously
conflicts with weaving — but "obviously" is not a test, and it has not been run on a display. Keep a
drag-look fallback (pointer-down + `pointermove`, as `samples/camera-rig/` does) and let the user
reach it. If you ship pointer lock as the only control, verify it on hardware first, and note that
the cursor vanishing is itself a change in what the weave sees.

## 8. Hardware checklist

A 2D browser can verify only two things: that the fallback path renders, and that your call
sequence is right. That is worth doing — this repo's own tests drive `SceneViewer` and the rig
surface through a **stubbed `XRDisplayLayer`** under `node --test` precisely because the interesting
behaviour is control flow (when the renderer is cleared, which camera is rendered, whether a rig
reached the layer), and a real layer plus a real WebGL context would hide the calls being counted.
It is how the samples were checked.

But it cannot tell you whether the picture is right. On a DisplayXR display, in the DisplayXR
Browser, verify:

1. **Stereo is actually arriving.** `handle.stats()` → `monoFrames` should be a small fraction of
   `frames`. A large fraction means the session is falling back under load, and your replay path is
   the only reason it does not blink.
2. **The subject sits on the plane.** Whatever you pointed convergence at should look welded to the
   glass — no doubling, no strain. Everything nearer pops out, everything further recedes.
3. **Head parallax works.** Move your head side to side: you should look *around* the content, not
   watch it slide. If the scene slides rigidly, the eye poses are not reaching your cameras.
4. **Convergence follows zoom.** Zoom or dolly and the subject should stay on the glass. If it
   drifts off, convergence is a constant where it should track the target distance.
5. **The HUD is crisp.** DOM text over the tile must be panel-sharp with no ghosting. Ghosting means
   it is being woven — check the overlay rules in §6.
6. **No raw-SBS drop when an overlay fades.** Trigger every full-bleed element you have — start
   screen, pause menu, modal — and watch the tile as it appears *and* as it goes. Two squished
   halves for a moment means the element is `opacity:0` rather than `display:none`.
7. **Resize repaints.** Drag the window, zoom the browser, rotate the display, drag to a
   different-DPI monitor. Any black flash is the no-op-resize clear from §4.
8. **Frame rate at your `renderScale`.** Two renders per frame is roughly twice the fragment cost of
   the flat page. Measure it woven, on the target machine, and tune the backing store — not the
   pixel ratio.

## 9. Pitfalls register

Consolidated, in the order they tend to bite:

1. **`isSessionSupported('inline-3d')` false-negatives.** It races the OS weave service's bind and
   resolves `false` before it. Detect with `createInline3D()` / `inline3DAvailable()`, never the
   probe, never a version or UA string.
2. **One `createInline3D()` per document.** Two live managers clobber each other's element-rect
   list every frame. Close one before opening the next.
3. **Never touch `renderer.xr`.** `immersive-vr` and `inline-3d` must not share a renderer, and
   libraries branch on `renderer.xr.isPresenting`.
4. **Two loops running.** Stop `setAnimationLoop` when the tile goes live; the session's frames
   drive `onFrame`.
5. **`setPixelRatio(anything but 1)`.** `getViewport()` is backing-store pixels and three multiplies
   your viewport by the ratio. It head-tracks perfectly and is zoomed and off-centre, so it reads as
   a projection bug.
6. **A 1:1 backing store.** The buffer is double-width while woven and 1:1 in mono. A 1:1 buffer
   gives each eye half a subject, with no error.
7. **Clearing before validating.** `views.length >= 2` and a viewport per eye, checked *before*
   `renderer.clear()`. Neither failure throws; both produce a dark tile.
8. **Skipping a frame instead of replaying.** An un-redrawn canvas can drop out of the aggregated
   frame and smear a stale sub-rect. Repaint the last good frame.
9. **Retaining an `XRView`.** It is valid only inside the callback that delivered it, and its
   matrices are live views onto memory the UA recycles. Replay from `Float32Array` copies via
   `setFromMatrices` / `setLocalFromMatrices`, and if you stash the view list to hand it to code
   further down the frame, null the references in a `finally`.
10. **Attach and setter flipped independently.** Parented eye + `setFromView` applies the camera
    transform twice; unparented eye + `setLocalFromView` renders from the origin. One decision, one
    function.
11. **The app camera outside the scene.** `renderer.render()` only auto-updates a camera whose
    `parent` is `null`, so parented eyes need a traversal to reach them. Most flat apps never call
    `scene.add(camera)`; the attach pattern requires it.
12. **A rig set this frame drives NEXT frame's views.** Use the attach pattern; never predict the
    camera forward.
13. **Absolute rig units on a camera rig.** `ipdFactor` and `metersToVirtual` are in *your* world
    units. A non-metre-scale scene needs `metersToVirtual`, and
    `ipd × m2v × diopters × 0.5` must stay ≤ 1.
14. **Convergence left at 0.** That is infinity — the entire scene in front of the glass. And in
    first person, convergence to the orbit target is ~0, which is the same mistake from the other
    end.
15. **No `near`/`far` on the eye cameras** — `EyeCamera` writes the projection matrix directly, so
    the scalars keep three's defaults and anything reading them as uniforms (Spark) misbehaves. But
    **never `updateProjectionMatrix()`** on one to "fix" that: it discards the runtime's off-axis
    frustum for a symmetric one, and the result looks nearly right.
16. **A library that double-fires because you now render twice.** Spark's sort is the known one
    (`minSortIntervalMs: 16` on Spark ≥2, `autoUpdate:false` plus one `spark.update()` from the app
    camera on 0.1.x), but anything keyed on `renderer.info.render.frame` or hung on
    `onBeforeRender` has the same shape.
17. **A no-op `setSize`.** It clears the buffer for an identical value; compare against
    `renderer.domElement.width/height` first, and repaint immediately on a real change.
18. **A render scale below ~0.5.** The interlace itself becomes visible. A quality ladder tuned on
    a flat page has no reason to stop there.
19. **A full-bleed overlay sharing the canvas rect.** Hide it with `display:none`, never
    `opacity:0`, and hide it *before* registering the tile — which means activating after the
    splash's fade has actually completed, not when you started it.
20. **`backdrop-filter` anywhere over a tile.** No z-order model fixes it. Near-solid backgrounds
    instead.
21. **Animating the canvas element itself.** Its rect and its weave disagree for the length of the
    animation. Animate a wrapper or the buffer's contents.
22. **Picking against an eye camera.** One cursor, one screen, one camera: `appCam`.
23. **Stopping your own loop before activation succeeded.** `setAnimationLoop(null)` belongs after
    the `addScene` path returns, never before it. A refused activation that already stopped the
    loop is a black page.
24. **Unpinned CDN imports.** If you load three, Spark or the SDK from a CDN or an import map,
    **pin the exact version** (`three@0.180.0`, not `three@latest`, not a range). A page that
    resolves `latest` at load time silently changes renderer version under a stereo loop that
    depends on `setViewport`/`setScissor` semantics and on Spark's peer floor — and it will change
    on a machine you are not looking at. The samples in this repo pin; so should you. If the SDK
    itself is loaded that way, import it **dynamically, inside a try/catch**, so a bad or moved pin
    degrades the page to its mono path instead of failing the whole module graph the way a static
    import would.

25. **A side-by-side backing store wider than ~3072 px stutters on the DisplayXR Browser
    (≤ preview-0.1.27).** Measured on hardware: a full-window scene canvas at scale 1 on a
    3840-wide panel is 6144 px wide, and the browser then fails its zero-copy read of the canvas
    every few frames (the canvas is still write-locked, the CPU fallback is refused) and re-shows
    the previous frame ~8 times a second. It is a width threshold — 3379 px still fails, 3072 px
    never does, height and pixel count are irrelevant, and it is flat across GPU load. Until the
    browser fix lands (displayxr-browser-pvt#24), cap your buffer width: `bufW = min(cssW*dpr*2,
    3072)`, i.e. per-eye 1536 px. Small tiles never hit it; only full-window scenes do. And read
    `keeps=` in the chrome log as a CUMULATIVE, throttled counter — the rate is Δcounter/Δt, never
    a count of log lines.
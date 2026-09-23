# Woven canvas rules: never show a raw side-by-side frame

Companion to [`authoring-inline-3d.md`](authoring-inline-3d.md). That page explains what a woven
window is. This one covers the failure that shows up on the first real deployment: for a moment,
sometimes a full second, a 3D tile shows **two squeezed halves side by side** instead of 3D. It
happens most often right after a navigation.

The rules below come from a production kiosk that chased this symptom for a week. They were then
checked against the DisplayXR Browser's compositor source. Every rule gives the reason for it
and the SDK call that satisfies it.

---

## 1. What the page is actually seeing

A woven window's backing buffer holds side-by-side (SBS) stereo ([the one
contract](authoring-inline-3d.md#the-one-contract-you-must-understand)). The browser weaves that
buffer onto the display **only once its compositor has *joined* the canvas**: it has matched the
rect your layer reports to the quad the canvas actually drew in this frame. Until the match
lands, the browser **withholds** the rect. The weave does not touch it, and what reaches the
screen is the page's own raster of the canvas, which is the raw SBS pair squeezed into the box.
That is the flash.

Four facts about the join matter to a page:

- **Constructing the layer is not the join.** `new XRDisplayLayer()` (what `addImage` /
  `addVideo` / `addScene` do for you) registers the canvas. The browser's compositor joins it
  later, on its own schedule.
- **A canvas that is fresh to the compositor takes longest.** The browser measured the window at
  **0.4–1.2 s** on a same-document navigation, where the outgoing screen's canvas dies in the same
  frame the incoming one is born. In the frames captured during that window, the incoming
  canvas had **not yet committed a real frame**: its backing store was still the default
  `300×150`. The compositor's view of the page was also still half the previous screen, so
  nothing in the frame *was* the new tile. No browser-side fallback can draw a frame it does not
  have. The page owns this case.
- **Nothing tells the page when the join lands.** Session frames, views and layer methods all
  look the same before and after the join. Views come from the runtime's eye locate, which knows
  nothing about the compositor. See [the browser ask](proposals/layer-joined-signal.md).
- **Your content arriving fast makes it worse.** The flash can only happen when real SBS pixels
  are already in the canvas while the join is still missing. A cached asset lands in tens of
  milliseconds, well inside the window. A slow asset usually lands after it. This is why the
  flash tends to affect one screen and not another screen built the same way.

So the page cannot make the join land sooner. What it controls is **whether stereo pixels are
on screen while the join is missing**.

## 2. The rules

### 1. One inline-3D session per document

The browser's element-rect channel is one whole-widget list. Two live managers overwrite each
other's list every frame, and a tile that is missing from the list is never joined. Call
`createInline3D()` **once** and add every window to it. The SDK warns if a second one goes live.
Between routes, `close()` the old manager before you open the next one, or better, keep one
manager for the life of the document.

### 2. Never remount a woven canvas inside a screen

A new `<canvas>` element brings a new WebGL context, and a new subject for the compositor to join.
Remounting on a state change (a React key change, or a Strict Mode double mount) re-creates the
window from §1 on purpose, every time. It can also hand the second renderer a context the first
one already disposed of, which freezes silently. Hold the canvas in a ref your framework never
re-renders over, and change what is **in** it:

- **Images and video:** register once and redraw the source. `addImage(canvas, sourceCanvas)`
  repaints from a canvas you own every frame
  ([motion, §1](authoring-motion-and-effects.md#what-to-do-instead)).
- **Scenes:** swap the content inside your `onFrame`, never the canvas.
- **Splats on the PlayCanvas backend:** `handle.setSource(src, { fadeMs, resetPose })`.

Calling `add*()` again on the same canvas is not a content swap. It closes the window's layer and
builds a new one.

### 3. Prefer one persistent canvas for the whole app

A canvas that survives every route change is fresh to the compositor exactly once, at boot. The
window from §1 then exists once instead of on every navigation. This is the only rule that
*removes* the race instead of shortening it. The cost is architectural: a shared "stage" in the
root layout that each screen attaches content to, instead of each screen owning a canvas. If you
can pay it, rules 4 and 5 become boot-time concerns only.

### 4. If a canvas must be created after a navigation, commit it before you register it

The measured flash frames had the new canvas at its default size, with no real frame committed.
Give the compositor a settled canvas before you ask it to join one:

1. Put the canvas in the DOM with its final CSS box and **`will-change: transform` from its first
   paint**, in your stylesheet. The SDK sets `will-change: transform; transform: translateZ(0)`
   at registration, which is one frame too late for a canvas's first appearance.
2. For `addScene`, **size the backing store yourself first**: 2× the box's aspect ratio, as the
   buffer will be while woven. The SDK never sizes a scene canvas. `addImage` / `addVideo` size
   theirs on activation.
3. Wait **at least two animation frames**, then call `add*()`.

This **shortens** the window. It does not close it: a page that deferred registration by four
frames still produced withheld frames on the browser's test rig. Rule 5 is the one that
guarantees the result.

### 5. Keep the canvas covered until `handle.firstWoven` resolves

Never let stereo pixels reach the screen before the first woven frame. Stack a cover over the
canvas: the poster, or an opaque block of the page background.

- **On top of the canvas, never behind it.** A canvas with opaque pixels hides whatever sits
  underneath, whatever that layer's own opacity.
- **A hard cut, never a fade.** A congruent sibling fading over the tile is its own version of
  the flash: a partial-opacity plate the size of the tile is exactly what rule 7 forbids.
- **Released on `handle.firstWoven`, not on first paint, and not on your own timer.**

```js
const handle = wall.addScene(canvas, onFrame);        // or addImage / addVideo / addSplat / addModel
await Promise.all([contentReady, handle.firstWoven]); // your load + the SDK's woven signal
poster.remove();                                       // cut, never fade
```

`handle.firstWoven` resolves **once and never rejects** with `{ woven, confirmed, reason, ms }`:

| result | meaning | what to do |
|---|---|---|
| `woven: true`, `reason: 'hold-elapsed'` | the window has drawn a real stereo frame on a layer that has existed for `firstWovenHoldMs` (default **1200**, the browser's measured worst case) | drop the cover |
| `woven: false`, `reason: 'layer-failed'` / `'session-ended'` / `'removed'` | this window will not weave. An image or video canvas has already been painted flat, and a scene's `onLayerLost` has already run | drop the cover onto the 2D fallback |
| `woven: false`, `reason: 'unsupported'` (`addSplat` / `addModel` only) | no inline-3D session: the viewer is on its mono path | same |

**`confirmed` is `false` today, always.** No shipping browser reports the join (§1), so
`firstWoven` is the documented worst case, measured by the SDK so that each page does not measure
it separately. When a browser can report the join, `firstWoven` settles on the report
(`confirmed: true`, no hold) and **the page does not change**. That is the reason to code
against it now rather than keep a local `setTimeout`. The browser ask is in
[`proposals/layer-joined-signal.md`](proposals/layer-joined-signal.md).

What counts as a "real stereo frame": for a scene, an `onFrame` that received two or more views
and did not throw. A frame with a short view list is the load fallback, and a frame that threw
drew nothing. For an image, an SBS paint of a loaded image. For a video, an SBS paint of a
`<video>` that has a current frame. A lazy tile that scrolls away before settling starts the
hold again on its next layer. `onFirstWoven(cb)` is the callback form.

Lower `firstWovenHoldMs` only for a canvas you know is not fresh to the compositor, for example
the persistent stage from rule 3 after its first ever reveal. `0` means "the first stereo frame".

**On a browser without draw-order occlusion** ([`inline3dOcclusionByDrawOrder()`](authoring-inline-3d.md#asking-which-mechanism-you-are-on)
is `false`), a cover over a *joined* tile is woven along with it. There, the cover looks
lens-scrambled from the moment the join lands until it is released. Do not mark a full-tile cover
`data-inline3d-overlay`: the SDK refuses a full-tile overlay with a warning on those browsers
(rule 8), and ignores it on draw-order browsers.

### 6. Hard-cut between screens: never have two woven canvases crossfading

A transition that blends the outgoing screen's canvas into the incoming one, by animating
`opacity` on either canvas or on their wrappers, breaks rule 7 on **both** canvases for the whole
fade. It also creates a case the compositor refuses outright. A canvas inside a render surface
can only be matched by shape, as the one 2:1 resource covering its rect. Two such candidates in
one region are **refused as ambiguous**, and neither is drawn from. Cut between screens. To blend
two pictures, blend them **inside one canvas**
([motion, §3 Crossfade](authoring-motion-and-effects.md#crossfade)).

Many woven canvases in one frame (a gallery wall) are fine. Each one joins by its own identity.

### 7. No CSS effects on a woven canvas or on any of its ancestors

`filter`, `opacity < 1`, `mask`, `clip-path`, `mix-blend-mode`, `backdrop-filter`: any property
that makes the browser give an element **its own render surface**. When the canvas or one of its
ancestors has one, the canvas is drawn into that surface instead of the page's root pass. Its
identity does not survive that, so the direct join misses. The best the browser can then do is
draw the tile **flat** (one eye, no 3D) in place, and sometimes it cannot find the tile at all.
The same goes for `border-radius`, `box-shadow` and `border` on the canvas: they are woven with
the packed pair and come out lopsided after the eye split. Use the SDK's options instead:

- rounded corners: `cornerRadius` on `addImage` / `addVideo`, or clip each viewport in a scene
  ([rounded corners](authoring-inline-3d.md#rounded-corners));
- a soft edge: `feather`;
- anything else: draw it into the canvas, per eye.

Scrolling and a *static* ancestor translate are fine. Animating the tile's geometry is a separate
rule ([motion, §1](authoring-motion-and-effects.md#1-why-a-woven-tile-must-not-move)).

### 8. Chrome over a woven canvas is a partial region

A caption band, a badge, a menu: on a browser with draw-order occlusion these need nothing
([2D over 3D](authoring-inline-3d.md#2d-over-3d--draw-order-occlusion)). On an older browser, mark
them `data-inline3d-overlay` (or call `handle.exclude(el)`), and keep them **smaller than the
tile**. An overlay congruent with the tile matches the canvas's own quad, so the SDK refuses it
with a warning rather than destroy the tile. Hide an overlay with `display: none`, never
`opacity: 0`. The declaration costs nothing on a draw-order browser, so one page works on both
generations.

### Two rules that keep a joined canvas joined

- **Redraw every frame.** A canvas that is not redrawn can drop out of the frame the compositor
  aggregates. The weave then reads a stale sub-rect and the tile smears. The SDK repaints
  `addImage` / `addVideo` windows every frame, including a buffering video (it re-commits the
  last frame). A scene must draw in every `onFrame`, and on a frame it cannot draw it must
  **replay the last good one** rather than skip ([validate before you
  clear](authoring-inline-3d.md#3-live-scene-threejs--webgl--addscenecanvas-onframe-opts)).
  `./viewer`, `./splat` and `./model` already do this.
- **Large scene canvases: consider `preserveDrawingBuffer: true`.** On older DisplayXR Browser
  builds, the weave's zero-copy read of a full-window WebGL canvas can race the page's next
  write, and the frame is dropped. Keep the SBS buffer no wider than the panel, and try
  `preserveDrawingBuffer` on the renderer (`addSplat(…, { engine: 'playcanvas',
  preserveDrawingBuffer: true })` on the PlayCanvas backend). See
  [porting pitfall 26](porting-three-js-apps.md#9-pitfalls-register).

## 3. Verifying a new screen on hardware

A 2D browser can check your call order (the tests in this repo drive a stubbed `XRDisplayLayer`
for exactly that reason). It cannot check the join. On a DisplayXR display:

1. **Stereo is arriving.** `handle.stats()` reports `{ frames, monoFrames }` per scene window. A
   high `monoFrames` share means the session is falling back under load.
2. **When the page thinks it is safe.** Log `(await handle.firstWoven).ms` and the time you
   registered. Log per-frame canvas size for the first two seconds as well, to see when the
   backing store actually became 2:1.
3. **What the browser actually did.** Launch the DisplayXR Browser with `--enable-logging` (add
   `--v=1` for the render-surface lines below), reproduce, and read `chrome_debug.log` in the
   browser's user-data directory:

   ```
   [DisplayXR] inline-3D withheld N of M weave rects: … ids=[<token>=<why>@<rect> …]
   ```

   The line is **throttled**: the first three occurrences, then one in every 300. A missing line
   on a given frame proves nothing. Visible tiles are named, up to 16, and off-viewport tiles are
   reduced to `+N offscreen`. What `<why>` means:

   | `why` | what it means | whose fix |
   |---|---|---|
   | `no-identity` | the canvas's rect reached the browser without the identity the join needs. This is the raw-pair flash from §1: the page's own pixels are on screen | page: rules 3–5 |
   | `no-quad` | the canvas drew nothing the compositor can see: it is not drawing, or it is occluded, or it is inside a render surface the browser could not trace | page: rule 7, or check that the canvas is drawing |
   | `cross-pass:mono`, `cross-pass:mono(cover,2:1)` | the canvas is inside a render surface (rule 7). The browser found it and draws it **flat in place**: no raw pair, but no 3D either | page: remove the ancestor effect |
   | `no-join` | nothing joined this rect. Seen at `@0,0 0x0` for lazy tiles pre-armed off screen, where it is harmless | page, if the rect is on screen |
   | `resolve-dropped` | the canvas joined, but its GPU resource could not be resolved this frame | browser |

   With `--v=1`, a separate `inline-3D cross-pass COVER … REFUSED ambiguous` line means rule 6:
   two 2:1 candidates in one render-surface region. Remove one of them.
4. **Which browser build has which fix: read the device, not a version string.** A version
   number does not tell you which compositor changes a build carries. The `why` token on the
   unit tells you what that build did. Browser release notes that list such changes are tracked
   separately.

## 4. What stays browser-owned

- **The join window itself.** Its 0.4–1.2 s length on a fresh canvas is compositor state that no
  page-side sequencing controls. Rules 3–5 exist *because* of it. A browser-side mono fallback
  for this exact case was built and measured, and it did not ship: in the measured frames nothing
  in the compositor's frame was the incoming canvas, so there was nothing to draw flat from.
- **Reporting the join.** Only the browser knows when a canvas has been joined. Until it reports
  that, `handle.firstWoven` is a timer with a stable contract. The request, and the shape it
  asks for, is [`proposals/layer-joined-signal.md`](proposals/layer-joined-signal.md).

# Proposal: a page-visible "layer joined" signal

**Status:** asked of the browser, not implemented. The SDK ships the page-facing half now as
`handle.firstWoven` (see [Woven canvas rules, rule 5](../woven-canvas-rules.md#5-keep-the-canvas-covered-until-handlefirstwoven-resolves)).
Today it settles on a worst-case timer (`confirmed: false`). This document asks for the browser
signal that would let it settle on a fact.

## The problem

A woven canvas is only woven once the browser's compositor has **joined** it, meaning it has
matched the rect the layer reports to the quad the canvas drew. Until then the browser withholds
the rect, and the page's own raster of the canvas, the raw side-by-side pair, is what reaches the
screen. For a canvas that is fresh to the compositor (a same-document navigation), the browser
has measured this at 0.4–1.2 s.

So pages keep a cover over the canvas and release it on a timer set to the worst case: 1200 ms
after registration. That is too long almost every time and still not provably long enough.

## What a page can observe today, and why none of it is the join

This was checked against the DisplayXR Browser's JavaScript surface:

| observable | what it actually reflects | is it the join? |
|---|---|---|
| `new XRDisplayLayer(session, canvas)` returning | the canvas is registered and its rect will be reported | no, this happens before the join |
| a session frame whose `getViewerPose()` has two views | the runtime answered the eye locate for this element's rect, in the browser process | no, the locate never consults the compositor |
| `XRDisplayLayer` methods (`getViewport`, `setViewRig`, `getDisplayInfo`, `getRenderingModes`, `requestRenderingMode`, `undock`, `getUndockCapabilities`, `excludeElement`, `close`) and the static `occlusionByDrawOrder` | geometry, rig, display and capability queries | no, none of them carries per-layer compositor state |
| session events (`renderingmodechange`, `hardwaredisplaystatechange`, `undockend`, and `trackingstatechange` where present) | display-global state | no, none of them is per layer |
| `[DisplayXR] inline-3D withheld … ids=[<token>=<why>@<rect>]` | **exactly this**: the per-rect verdict of the frame being presented | yes, but it is only a log line in the GPU-process compositor. Nothing sends it back to the renderer |

The verdict exists. It is computed every frame at the point where the compositor builds the
weave submission, and it is written to the log. It is just never sent to the page.

## The ask

Carry the compositor's per-layer verdict back to the renderer and expose it on the layer.

```webidl
// on XRDisplayLayer, gated like the rest of the inline-3D surface
readonly attribute DOMString wovenState;   // "pending" | "woven" | "withheld"
readonly attribute DOMString? withheldReason; // the log's <why> token while "withheld", else null
```

- **`"pending"`**: no presented frame has reported this layer yet. This is the value from
  construction until the first report.
- **`"woven"`**: the most recent presented frame **submitted this layer's rect to the weave**.
  This is the compositor's "prepared" outcome, the opposite of "withheld".
- **`"withheld"`**: the most recent presented frame withheld the rect. `withheldReason` is the
  same token the log prints (`no-identity`, `no-quad`, `no-join`, `cross-pass:mono`, …), so the
  field and the page describe it in one vocabulary.

It is modelled on the eye-tracking-state change (`XRSession.trackingState` +
`trackingstatechange`). That pattern already solved the same shape of problem:

1. **Carry a level, not an edge, every frame.** The verdict is already computed per frame. Send
   it as a level on a path that already exists per frame, so a layer created mid-session learns
   its current state on its first reply. An edge-only channel would leave a late layer on
   `"pending"` until something changed.
2. **Edge-detect in Blink.** The renderer latches the level and changes the attribute only on a
   real change.
3. **`"pending"` is a real state and not `"withheld"`.** The same argument as `trackingState`'s
   `"unknown"`: a layer nobody has reported on yet is not a claim that it was refused, and
   folding the two together would make every page wait on a report that has not been made.
4. **Per layer, so an attribute rather than an event.** `XRDisplayLayer` is not an
   `EventTarget`, which is why the session-level events live on `XRSession`. A per-layer state
   does not need an event. The SDK already runs a per-frame loop over its layers and would read
   the attribute there. If an event is wanted as well, it belongs on the session and should
   carry the layer (`event.layer`), because a plain `Event` could not say which of N layers
   changed.
5. **Presented frames only.** Report what reached the display, not what was aggregated and then
   dropped. "Woven" has to mean the lens saw it.

## What the SDK does with it

`handle.firstWoven` already exists and its contract does not change. The SDK will probe for the
attribute with `'wovenState' in XRDisplayLayer.prototype`. That is the `in` operator, which never
invokes the getter: reading an IDL attribute getter off the prototype throws
`Illegal invocation`. Where the attribute is present:

- `firstWoven` settles on the **first `"woven"`** of the window's current layer, with
  `{ woven: true, confirmed: true, reason: 'joined' }` and no hold. A lazy tile's new layer is
  judged on its own reports, as it is today.
- `"withheld"` does not settle `firstWoven`. The cover stays up, which is the point.
  `withheldReason` becomes readable from `handle.stats()` for diagnostics.
- Where the attribute is absent, nothing changes: the timer path stays as it is, and so does
  every page written against it.

Nothing here asks the browser to change *what* it weaves or withholds. It asks only that the
browser report the decision.

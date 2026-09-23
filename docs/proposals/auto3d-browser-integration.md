# Proposal: auto-3D for existing sites, built into the DisplayXR Browser

Status: **proposal**. The prototype it describes lives in
[`tools/auto3d-shim/`](../../tools/auto3d-shim/README.md). This page covers how that prototype
would ship inside the browser, what stays browser-owned, and what the browser has to add first.

## What it is

A page that renders with three.js or PlayCanvas, and was never written for a 3D display, becomes a
woven inline-3D window without any change to the page. The prototype is an unpacked MV3 extension
with three MAIN-world content scripts:

- `core.js`: session and layer lifecycle, the side-by-side sizing rule, the camera rig, the
  convergence estimator, the cover, the HUD and the kill switch;
- one adapter per engine, `three-adapter.js` and `playcanvas-adapter.js`, which hook the engine's
  own renderer and draw one view per eye from the session's views.

It uses only the public inline-3D surface: `navigator.xr.requestSession('inline-3d')`,
`XRDisplayLayer`, `setViewRig`, and the `getViewerPose()` views. The page's own camera supplies
the pose (the attach pattern), and the runtime owns the off-axis math.

## How it ships: a component extension, like the immersive shim

The WebXR `immersive-vr` shim (`tools/immersive-shim/`) already ships this way. Its script is
vendored verbatim from this repo into the browser's component-extension resources, loaded on every
profile at startup, and gated by a compile-time component-extension allowlist entry plus a
command-line kill switch. auto-3D would follow the same pattern.

| piece | proposal |
|---|---|
| source of truth | `tools/auto3d-shim/{core,three-adapter,playcanvas-adapter}.js` in this repo, vendored **verbatim** by a browser patch. A browser-side edit is a bug: fix it here and re-vendor. |
| manifest | a component manifest with the same `content_scripts` entry as `manifest.json` (MAIN world, `document_start`, all frames, three files in order) and a fixed extension key, so its id is stable for the allowlist |
| arming | **off by default**. Armed by a switch the browser appends at startup only on builds that ship it (for example `--dxr-auto-3d`) |
| kill switch | `--no-dxr-auto-3d` stops the extension loading at all, and stays authoritative over any per-site setting. A policy / enterprise off is the same switch |
| allowlist | the first release converts **only on allowlisted origins**, compiled in: engine examples, our own demo pages, and hosts we have tested by hand. Everywhere else the scripts load inert, and the per-site `Ctrl+Alt+3` opt-in is the user's way to try any other site. Widening the list (or flipping the default to on everywhere) is a separate decision, made on the coverage numbers the prototype collects |
| per-site state | today, `localStorage` on the page's own origin, which the page can read and clear. In the browser, this should move to extension storage (per profile, keyed by origin), so the page cannot see or change it |
| updates | ride the browser release, as the immersive shim does. There is no separate update channel |

Why a component extension rather than Blink code. The adapters are engine-specific and will change
at the pace of three.js and PlayCanvas releases, while the browser rebases onto Chromium every
month. JavaScript that carries no Blink patch costs nothing at a rebase, and a fix ships as a
re-vendor. The immersive shim chose this path for the same reason. The browser pays one fixed
patch for the component-extension plumbing; the immersive shim's patch already created most of it.

## The dependency: `XRDisplayLayer.wovenState`

The cover in `core.js` is a still of the last mono frame, held for a fixed **1200 ms** after the
layer is created. That is the `firstWoven` hold from [woven-canvas rules](../woven-canvas-rules.md)
rule 5, and the reason for it is the same: no shipping browser tells a page when the compositor
has joined a canvas. A fixed hold is too long on a warm canvas and can be too short on a slow
machine.

[`layer-joined-signal.md`](layer-joined-signal.md) asks for `XRDisplayLayer.wovenState`
(`"pending" | "woven" | "withheld"`) plus `withheldReason`. When it lands, the core changes in one
place:

- `tickCover` releases on `wovenState === 'woven'` instead of `now - layerAt >= holdMs`, and keeps
  the timer only as a fallback when `'wovenState' in XRDisplayLayer.prototype` is false;
- a `'withheld'` state that persists (for example `cross-pass:mono`, an ancestor CSS effect)
  becomes a HUD reason, and after a timeout the canvas goes back to 2D rather than sitting flat
  under a layer;
- `window.__dxrAuto3D.state()` reports the token, so the checklist's log reading becomes a
  console call.

Nothing in the adapters depends on this. The weave-slot probe (`getDisplayInfo()` null → back to
2D, browser#162) stays as it is.

## What stays browser-owned

- **The join.** When the compositor has matched the canvas, and the `withheld` verdict. The shim
  can only cover the canvas until then, and needs `wovenState` to know when.
- **One session per document, and the arbitration with the page.** The shim stands down for good
  in a document the moment the page requests `inline-3d`, `immersive-vr` or `immersive-ar`. Inside
  the browser this ordering should be enforced by the browser rather than by wrapping
  `navigator.xr.requestSession`. Otherwise a page that requests a session *after* the shim has
  converted gets a second session, and the browser's one-session rule then refuses one of them. The
  simplest browser-side form: a page request ends the extension's session first.
- **The eye views and projection.** They come from the runtime through the session, as for any
  inline-3D page. The shim sends a camera rig (`setViewRig`) and never computes a frustum.
- **The immersive path.** Pages with WebXR `immersive-vr` keep going through the converted
  immersive session. auto-3D never starts `app.xr` / `renderer.xr`, and stands down when a page
  does.
- **Kill switch and allowlist.** These are browser switches, not page-visible settings.

## What must be true before it is on by default

1. `wovenState` shipped, and the cover released on it (above).
2. Hardware sign-off per engine on the Windows display. For each page: stereo confirmed eye by eye,
   no raw pair at the switch (no `no-identity` token after the cover drops), comfortable depth at
   the default `depth` 0.3, and frame rate recorded. Every converted draw runs twice.
3. Post-processing handled, or cleanly flat. Today both engines stand down to 2D on post-processing
   chains, CameraFrame and multi-camera pages, which is a large share of modern sites. The next
   adapter step is per-eye render-target twins.
4. For PlayCanvas: detection of apps that expose no global depends on a constructor detail
   (`AppBase._applications[canvas.id] = this`). That is fine for a prototype, fragile for a
   product. The durable fix is a small upstream hook: `AppBase` announcing each app it constructs,
   the way three.js announces renderers to `__THREE_DEVTOOLS__`. It should be proposed upstream
   before auto-3D turns on by default.

## Out of scope

WebGPU renderers (both engines), OffscreenCanvas / worker rendering, generic WebGL interception
for engines without an adapter (the browser cannot know the camera), and changes to the SDK. SDK
pages already own their session, and auto-3D stands down for them.

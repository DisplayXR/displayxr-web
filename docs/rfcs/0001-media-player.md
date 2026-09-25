# RFC 0001 — a media player module

**Status:** draft. **Tier:** preview (like `/splat`, `/model` — see `docs/sdk-stability.md`).
**Author:** architecture pass, 2026-09-22. **Touches:** new `@displayxr/inline3d/player` subpath only;
no change to core.

## Problem

The SDK has a video *window* today: bring a playing SBS `<video>`, `addVideo(canvas, videoEl)` draws
its current frame into the woven buffer every frame (`docs/authoring-inline-3d.md:67-79`,
`js/inline3d.js:894-897`). That's a paint primitive, not a player — the page still owns `<video>`,
its transport, its source format, its playback state. There is no module a page can point at a URL
and get a 3D title with `play/pause/seek`, the way `addModel`/`addSplat` turn a URL into a framed,
orbitable object in one call (`model.d.ts:106-111`, `splat.d.ts:239-252`). A streaming-style demo
page — kiosk-style 3D movie tiles with real transport controls — has nowhere to start from but
hand-rolling `<video>` plumbing per page. This RFC scopes `@displayxr/inline3d/player`.

## 1. API shape

```js
import { createInline3D } from '@displayxr/inline3d';
import { addPlayer } from '@displayxr/inline3d/player';

const wall = await createInline3D();
const p = await addPlayer(wall, canvas, 'title-sbs.mp4', { poster: 'title-poster.jpg', loop: true });
p.play(); p.on('ended', () => p.seek(0));
```

`addPlayer(wall, canvas, src, opts) → PlayerHandle`, matching `addModel`/`addSplat`'s
`(wall, canvas, src, opts)` shape exactly, so a page that already knows one preview-tier module
knows the third. `wall` may be `null`/unsupported the same way (renders flat 2D, decision below).

- **Handle:** `play()/pause()/seek(t)/currentTime/duration/ended`, `on('play'|'pause'|'ended'|
  'timeupdate'|'error', cb)`, `remove()`. Deliberately the `<video>` element's own vocabulary —
  a page author already knows it, and it maps onto `HTMLMediaElement` 1:1 since a `<video>` is
  what's underneath (decision below).
- **`opts.format: 'sbs' | 'tb' | 'mono' | '2d'`, default `'auto'`.** Auto-detect order: (1) a
  sidecar `<src>.json` (`{format, width, height}` — cheap, cacheable, works with any static
  host); (2) filename convention `*_sbs.*` / `*_tb.*` / `*_2d.*`, mirroring the mediaplayer demo's
  own filename-first convention (`~/Documents/GitHub/displayxr-demo-mediaplayer/README.md`, stereo
  layout resolution list); (3) else assume `'sbs'` — **not** "assume mono": a player import only
  happens on a page that wants 3D playback, so silently degrading a mis-tagged 3D file to flat is
  the wrong default failure. `'tb'` (top-bottom) is accepted and re-packed to SBS on an offscreen
  canvas before paint — one extra `drawImage` per new frame, see §3 — closing the gap the current
  `addVideo` doc calls out as unsupported (`docs/authoring-inline-3d.md:79-80`: "Top-bottom encodes
  aren't supported; re-pack to SBS first"). `'2d'` plays flat, full-tile, no eye split — for a
  catalogue that mixes 2D and 3D titles under one component; a 2D→3D conversion path is **out of
  scope** for this RFC.
- **`layout`** governs a source buffer whose aspect isn't the box's. Decision: **letterbox, never
  crop.** The one-contract rule is that a 16:9 movie needs a 32:9 backing buffer in a 16:9 box
  (`docs/authoring-inline-3d.md:29`); a source authored 2:1-per-eye (e.g. a 2:1 SBS panorama-style
  clip) dropped into a 16:9 box gets letterboxed bars baked into the offscreen SBS buffer before
  the weave sees it, matching how `addImage`/`addVideo` already own buffer shaping
  (`docs/authoring-inline-3d.md:31-33`). Cropping silently discards authored frame; letterboxing
  is recoverable (a page can widen the box later) and is the safer default for a player component
  nobody hand-tunes per title. `opts.fit: 'letterbox' | 'crop'` for a page that wants the other.
- **Controls — SDK-drawn minimal transport as `data-inline3d-overlay`, page-owned for anything
  more. Decision: ship the SDK chrome as a *partial-region* bottom bar, not baked into the canvas.**
  Two constraints rule out the alternatives:
  - **Baking transport into the SBS buffer (like `cornerRadius`, `docs/authoring-inline-3d.md:789-
    797) is wrong for anything interactive.** Buffer-baked controls are per-eye pixels with no DOM
    hit-testing — a play button drawn into the canvas can't receive a click. It would also add a
    second per-frame draw on top of the video repaint (§3), for chrome that rarely changes.
  - **A full-tile DOM overlay is illegal on legacy (pre-draw-order-occlusion) browsers.** The
    exclusion contract matches an excluded element's rect to the canvas's own composited-layer
    quad at ≥70% area overlap; an overlay that covers the whole tile matches the canvas's *own*
    quad, kicks the canvas out of the weave input, and the tile presents its raw squished
    SBS pair — the SDK refuses this with a console warning rather than silently breaking a page
    (`docs/authoring-inline-3d.md:941-948`). A full-screen transport scrim would hit this exactly.

  So: `addPlayer` renders its default chrome (play/pause, scrub bar, time) as an absolutely
  positioned DOM strip anchored to the canvas's bottom edge, auto-tagged `data-inline3d-overlay`
  (`docs/authoring-inline-3d.md:896-923`) — a **partial** region, legal under both the legacy
  exclusion path and a no-op-but-harmless draw-order-occlusion browser
  (`docs/authoring-inline-3d.md:844-895`). `opts.controls: 'sdk' | 'none'` (default `'sdk'`);
  `'none'` leaves the page to build its own chrome against the handle's `play/pause/seek` API and
  `timeupdate` event — the same pattern a page already uses for `exclude()`
  (`docs/authoring-inline-3d.md:924-926`).
- **Keyboard/remote input**, because a kiosk panel has no touch: `Space` toggles play/pause,
  `←/→` seek ±10s, `↑/↓` volume, `M` mute, `F` fullscreen-the-tile (CSS, not an SDK concept) —
  bound to the canvas/chrome container, not `document`, so a page with several players only
  drives the one with focus. `opts.keyboard: false` to opt out (a page that owns its own remote
  mapping).
- **Mono fallback on tracking loss is the core's, and opt-in: `untrackedFallback`.** The runtime
  reports whether a viewer is tracked (it may hand that to the vendor plug-in), and the browser
  passes it as `XRSession.trackingState` — `'tracking' | 'searching' | 'unknown'`, filled in on every
  frame, with `trackingstatechange` on each change (DisplayXR Browser patch 0195). The SDK mirrors
  it as `wall.trackingState` + `wall.on('trackingstatechange', (state, ev) => …)`, on every tile
  handle too. Whose job the flat switch is depends on the eye-tracking mode
  (`displayxr-runtime`: `docs/specs/vendor/eye-tracking-modes.md`): on a **MANAGED** display (the
  default, and Leia's) the vendor eases the eyes together and reports `'searching'` only once the
  display is already 2D, so the page does nothing to the pixels; on a **MANUAL** display the app
  must, and `createInline3D({ untrackedFallback: 'mono' })` does it for image/video windows — eased
  to the left eye in both halves of the SBS buffer on `'searching'`, back on `'tracking'`, no buffer
  reallocation. Default `'none'`. `addPlayer` is `addVideo` underneath, so it inherits this with no
  player code. A 2D-panel mode is the other flat case, handled by the mode-driven rig collapse.
- **Composition with one-session-per-document.** `createInline3D` is already one session per page
  (`docs/authoring-motion-and-effects.md:287`, `docs/authoring-inline-3d.md:653-661` — many
  windows share one `wall`), so many `addPlayer()` calls on one page are many *windows* on the
  same session, exactly like many `addImage` tiles. **New rule specific to players, not covered by
  the existing lazy-window lifecycle:** only one player may have an active `<video>` decode +
  audio track at a time — a page of six kiosk tiles must not decode six streams. `addPlayer`
  therefore takes `opts.group` (default `'default'`); calling `.play()` on a player pauses every
  other live player in the same group. This is playback-session policy layered over the SDK's
  existing visibility-driven lazy weave (`docs/authoring-inline-3d.md:653-668`), not a change to
  it — a scrolled-away player already drops its weave layer; grouping additionally drops its decode.

## 2. Sources & streaming

- **Progressive MP4 + HTTP Range is the v1 baseline.** It works from any static host or CDN
  because `<video>` + range requests is how browsers already stream MP4; nothing DisplayXR-specific
  is needed server-side. **Not independently verified against a live Supabase Storage URL in this
  pass** — Supabase Storage is backed by S3-compatible object storage and S3 supports byte-range
  `GET`, so a public object URL *should* return `206 Partial Content` on a `Range` header the same
  way a plain S3/CloudFront asset does, but this needs a `curl -I -H "Range: bytes=0-1"` check
  against a real bucket before shipping a sample that depends on it — **flagged as unverified**.
- **HLS via `hls.js` — optional, not v1.** MSE-based, adds a dependency (mirroring how `/splat`
  and `/model` declare `three`/`@sparkjsdev/spark` as *optional peers*, `package.json:66-76`), and
  buys adaptive bitrate + true live streaming that a kiosk/demo page doesn't need. `addPlayer`
  detects `.m3u8` and dynamic-imports an `hls.js` adapter only then, so a progressive-MP4-only page
  pays nothing for it — same "core stays dependency-free" posture as the rest of the SDK
  (`README.md:29-31`).
- **MV-HEVC / Apple spatial video — out of v1, flagged for v2 research.** Decode support is
  effectively Safari-only today (macOS/iOS/visionOS via AVFoundation); Chromium/Blink — which is
  what the DisplayXR Browser is built on — has no MV-HEVC decode path as of this writing. Until
  that changes, an MV-HEVC source cannot become an SBS buffer without a server-side re-mux to SBS
  H.264 ahead of time, which is a pipeline problem, not an SDK one. **Label: estimate — verify
  current Chromium MV-HEVC status before committing a v2 date to it.**
- **2D sources** play flat (`format:'2d'` above); a 2D→3D conversion path (on-the-fly monocular
  depth) is explicitly **out of scope** — a different, heavier pipeline than this module.
- **Offline/kiosk:** bundled local files work today with zero new code (a `<video src="./local.mp4">`
  needs no network). Budget: SBS H.264 1080p (so 3840×1080 packed) at 8–12 Mbps ≈ **60–90 MB/min**
  (label: estimate, standard bitrate-to-size arithmetic, not measured on this codec/resolution
  combination in this repo).

## 3. Cost & performance

- **Per-frame texture upload scales with pixels, and a 3840×1080 SBS frame is 4× a 1920×1080 one.**
  `addVideo`'s repaint is one `ctx.drawImage(video, …)` per live window per XR frame — unconditional,
  not gated on a new decoded frame (`js/inline3d.js:2493`, called from the per-frame loop at
  `js/inline3d.js:2547-2606`). That's the cost the motion doc already budgets: "every live image
  and video window repaints its source canvas every frame — that is what you are actually
  budgeting" (`docs/authoring-motion-and-effects.md:222-224`). A player inherits this exactly,
  because it's built on `addVideo` (see below).
- **`requestVideoFrameCallback` is a real, small win the current `addVideo` does not take.**
  Today's per-XR-frame `drawImage` re-draws the *same* decoded video frame multiple times between
  actual decodes whenever the display's frame rate exceeds the video's (60 Hz weave vs. a 24/30 fps
  source) — wasted GPU upload, not wasted visual fidelity (`_recommitLastFrame`,
  `js/inline3d.js:2508-2521`, already exists for the *buffering* case but not the *steady-playback*
  one). `addPlayer` gates its repaint on `video.requestVideoFrameCallback` where available (all
  Chromium — i.e. exactly the DisplayXR Browser's base) and falls back to the current
  always-`drawImage` behavior elsewhere. **Estimate:** for a 30 fps source on a 60 Hz panel this
  roughly halves the video-window's per-frame upload cost; not measured on DisplayXR hardware in
  this pass.
- **What a 15.6" 1080p panel at 60 Hz needs:** the panel's own resolution caps useful per-eye detail
  well under full 1080p once interlaced — the repo's own video sample encodes at 640×360/eye
  deliberately, citing "a 3D display's recommended render scale is ~0.5×0.5 … ~604×340 of real
  detail per eye is all that survives" (`samples/windows/app.js:33-39`). The same logic applies to
  a player title: encoding SBS masters at ~1280×720 total (640×360/eye) is a reasonable default
  recommendation for this class of panel, not a hard SDK limit — a page targeting a larger/HiDPI
  panel should encode higher. **Label: derived from an existing, checked-in comment; not
  independently re-measured for this RFC.**
- **Decode stays on the GPU via `<video>` — no change needed.** `addPlayer` never touches decoded
  pixels except the single `drawImage`/`copyTexImage`-style upload into the SBS canvas; hardware
  video decode is the browser's job, exactly as it is for today's `addVideo` demo.

## 4. Undock

**Recommendation: v1 does not support undock.** Two independent facts rule it out today, not just
a scoping choice:

1. **The undock contract is typed to `'model'|'splat'` only.** `UndockType` is
   `@typedef {'model'|'splat'} UndockType` (`js/inline3d-undock.js:19`), and `undock()` rejects any
   other `opts.type` with a `TypeError` (`js/inline3d-undock.js:192-196`). A `'video'` (or
   `'player'`) type does not exist on either the JS contract or, per the diagnostic weave line in
   the show-pvt reference integration, on the browser side either — its readout reports
   `undock model:true splat:true` with no video entry
   (`~/Documents/GitHub/displayxr-show-pvt/docs/TUNING.md:96`).
2. **`displayxr-demo-mediaplayer` is a separate, standalone native app, not the floating viewer the
   undock protocol spawns.** It's an independent OpenXR client launched by file path or drag-drop
   (`~/Documents/GitHub/displayxr-demo-mediaplayer/README.md` — "Build & run", "You can also drag
   files or a folder onto the window"), coupled to the runtime only by the OpenXR extension wire
   protocol, with **no reference to the `displayxr-view:` protocol or `undock()`** anywhere in its
   docs (checked: no match in that repo's `*.md`). It plays SBS video/images well — hardware decode
   per OS, 114 FPS measured on M1 Pro (`README.md` "Verified on macOS") — but a page cannot spawn
   it the way undock spawns the model/splat viewer today.

Extending undock to video is real future work (browser-side: teach the floating viewer's launch
grammar a `type=video` with a play/pause affordance; SDK-side: widen `UndockType` and the
`opts.type` check at `js/inline3d-undock.js:192`) — flagged for v2, not attempted here.

## 5. Web component

**Recommendation: ship the imperative module first, `<dxr-video>` later, not in v1 or v2 of this
RFC.** `docs/sdk-stability.md`'s own roadmap lists `<dxr-scene>`/`<dxr-video>`/`<dxr-image>` web
components as **intentionally deferred**, gated on the Phase-2 N-view render contract landing
(*"They depend on the Phase-2 N-view render contract and the Option-B region model, which are not
final — freezing them now would box in a public API on a moving foundation"* —
`docs/sdk-stability.md`, "Not in 1.0" section, item 1). Nothing about a media player changes that
gate; building `<dxr-video>` now would freeze a custom-element API on the same moving foundation
the stability doc explicitly declines to build on yet. It also matches how `/splat` and `/model`
shipped: imperative `addSplat`/`addModel` first, preview tier, no custom element — the pattern this
RFC's `addPlayer` follows.

## 6. Plan

**v1 — minimal (this RFC's scope):**
- SBS progressive MP4 via `addVideo` underneath (`addPlayer` wraps a `<video>` it creates and
  manages, calling `wall.addVideo(canvas, video)` — reusing the whole paint/lifecycle path rather
  than duplicating it)
- format auto-detect (sidecar JSON → filename convention → assume SBS), `'tb'` re-pack
- SDK transport chrome (`data-inline3d-overlay` bottom bar), keyboard input
- mono fallback on tracking loss via the core's opt-in `untrackedFallback: 'mono'` (no player code, §1)
- one-active-player-per-group playback policy
- `docs/rfcs` cross-linked from `docs/authoring-inline-3d.md`; new
  `js/inline3d-player.js` + `player.d.ts`, `package.json` `./player` export
  (mirroring `./splat`/`./model`, `package.json:8-33`)
- sample: `samples/player/` — a small grid of 3D title tiles with transport, on the pattern of
  `samples/windows/` and `samples/model/`

  **Effort: 7–9 engineer-days** (estimate): 2d module + format detect/repack, 2d chrome + keyboard
  + grouping, 1d mono-fallback wiring/verification, 1d `requestVideoFrameCallback` gating, 1–2d
  sample + docs, 1d hardware pass.

**v2 (not this RFC, flagged for follow-up):** HLS via `hls.js`, playlists/queueing across the
`group` mechanism, undock (`type=video`, needs browser-side work per §4), MV-HEVC re-evaluation.

**Risks:**
- Supabase/S3 Range-request behavior unverified (§2) — could block the "any object store" claim
  for a specific host until checked.
- `requestVideoFrameCallback` gating changes *when* a repaint happens relative to the XR frame
  loop; needs the same "repaint the last good frame, never skip" discipline the doc already
  requires for scenes (`docs/authoring-inline-3d.md:117-124`) so a callback that fires between XR
  frames doesn't leave a window un-repainted for one.
- Chromium MV-HEVC status is a moving target; don't hard-commit a v2 date without re-checking it.

**Acceptance test (real panel):** a `samples/player/` tile plays a bundled SBS MP4 at native
resolution with `play/pause/seek` from the SDK chrome and from keyboard, holds correct L/R eye
routing through a scrub, degrades to mono left-eye on `trackingstatechange → 'searching'` and
recovers on return, and — with three player tiles on one page — playing one pauses the other two
in its group while all three keep their weave layers (scroll-visibility lazy lifecycle unaffected,
only decode is grouped).


---

## Addendum A — Surface mode: the player on an existing splat handle

*Status: proposal, for review before any code. 2026-09-25.*

### Why

The Show Spatial team will not use `addPlayer` as shipped, because it creates a second woven
surface (`wall.addVideo`). Their app is one session and one woven canvas that is never torn down
(woven-canvas rules 2 and 3), with video played on that canvas through the splat handle's
`setVideo`. A full-screen player tile on top of it is the "two overlapping tiles" case. What
would work for them is a **surface mode**: the player provides transport, controls and title
picking, and draws through `setVideo` on the handle they already have, owning no canvas of its
own. It also answers the "two video paths in the SDK" question from #71's review: there are two
*surfaces*, and one player drives either.

### A1. API shape: a separate entry point

Two options:

- **(a) An option on `addPlayer`:** `addPlayer(wall, canvas, src, { surface: handle })`.
- **(b) A separate entry point:** `attachPlayer(handle, src, opts) → PlayerHandle`.

**Recommendation: (b).** The two modes differ in ways an option would hide:

| | `addPlayer` (owns a surface) | `attachPlayer` (borrows one) |
|---|---|---|
| Arguments | `wall`, `canvas` | the splat handle only |
| Creates | a woven window (`wall.addVideo`) | nothing woven; it uses the handle's video slot |
| Ends with | `remove()`: its window is gone | `detach()`: `setVideo(null)`, and the scene comes back as it was |
| Tile options | `width`, `height`, `cornerRadius`, `feather`, `observe` | none (the handle's own tile) |

Under (a), `canvas` and the tile options would be silently ignored in one mode, and `remove()`
would mean two different things. Under (b), each entry point takes only what it uses. Both return
the same `PlayerHandle` type, so a page's transport and voice code does not branch (A4). Inside
the module, one player core sits on one of two *surface adapters*: a canvas adapter (`addVideo`,
today's code) and a splat adapter (`setVideo`).

```js
import { attachPlayer } from '@displayxr/inline3d/player';

const splat = await addSplat(wall, canvas, 'home.sog', { engine: 'playcanvas' });
// … later, on the Watch screen:
const player = attachPlayer(splat, titles[0].src, { format: 'sbs', fit: 'contain' });
player.play();
// … leaving Watch:
await player.detach();          // setVideo(null): splat, pose, lens and rig exactly as they were
```

### A2. Who owns the `<video>`, and how `setVideo(null)` interacts with `setSource` and crossfades

**The player owns the element.** It creates the `<video>`, as `addPlayer` does, and passes the
*element* to `setVideo`. By `setVideo`'s contract an element you pass stays yours: the splat
module never plays, pauses or releases it. So transport, events, preload and the decoder lifetime
stay in one place, the player, in both modes.

**Lifecycle on the handle:**

1. `attachPlayer` → `handle.setVideo(videoEl, { format, fit, autoplay: false })`. The scene stays on
   screen until the video's first frame, then switches in one task. The scene is the poster, so
   there is no blank gap.
2. `setSource(next)` → the player prepares a **second** `<video>` for `next` and calls
   `handle.setVideo(secondEl, …)`. That swaps at the second element's first frame and keeps the
   original pre-video state, so a later `setVideo(null)` still restores the scene. The player
   then releases the first element. Two elements alternate, and the plane never shows an empty
   element.
3. `detach()` → `handle.setVideo(null)`: the splat, pose, lens and declared rig come back exactly,
   and the player releases its element. `detach()` resolves when the restore has happened.
4. The page's own `setSource` on the **splat** rejects while a video is on (`setVideo`'s rule), so
   leaving Watch is `await player.detach()` first. The player never calls `setVideo(null)` except
   in `detach()`.

**If something else takes the slot:** a page (or a second player) calling `handle.setVideo(…)`
while a player is attached supersedes it. The player sees its pending or current video replaced,
stops driving the handle, and emits a `'detached'` event with `{ reason: 'superseded' }`; it never
fights for the slot.

**Crossfades:** `setVideo` takes a URL or an `HTMLVideoElement`, not a canvas, so the canvas
player's crossfade (a mixer canvas standing in for the video) cannot be reused. Proposal:

- **v1 of surface mode: `transition: 'cut'` only.** Because of step 2 the cut is already clean:
  the swap happens at the next title's first frame, with no black between.
  `transition: 'crossfade'` warns once and cuts.
- **Follow-up, in `./splat`:** `setVideo(src, { transition: 'crossfade', durationMs, easing })`,
  done on the GPU (the plane samples the outgoing and incoming textures for the duration). That
  keeps one crossfade vocabulary across `setSource` for splats, the canvas player and the
  surface player. It is a change to David's module, so it is listed here, not assumed.

### A3. Excluding the controls from the weave when the player owns no canvas

The controls (transport bar, title line, centre button, key pip, spinner) are page elements over
the handle's woven canvas, the same as over the player's own canvas today. The only difference
is where they are inserted:

- **Placement:** as siblings of the handle's canvas, in its parent element, the same as the
  canvas player does with its own canvas. The parent must be positioned; the player sets
  `position: relative` only if it is `static`, as today. `opts.chromeContainer` can name another
  element for apps whose canvas parent is not the right box.
- **Browsers with draw-order occlusion:** nothing to do. The browser composites any 2D content
  over the tile by draw order.
- **Legacy browsers:** each overlay keeps `data-inline3d-overlay`, and the core's auto-scan finds it
  under the woven canvas's parent. The player also calls `handle.exclude(el)` for each overlay
  and `handle.unexclude(el)` on detach, so exclusion does not depend on the page's DOM nesting
  either way.
- **The chrome rules still apply:** partial regions only (no full-tile plate), no
  `backdrop-filter`, and no glow outside a control's own box.
- **Fullscreen defaults off in surface mode.** Fullscreening the handle's container would
  fullscreen the whole app's canvas. `fullscreen: true` is still allowed for apps where that is
  the intent.

### A4. Playlist API parity between the two modes

Show Spatial's voice commands must work against either mode, so the playlist layer sits **above**
the surface adapter and is the same code for both:

```ts
interface PlayerTitle { id: string; src: PlayerSource; title?: string; poster?: string; format?: PlayerFormat }

player.titles            // readonly PlayerTitle[]   (set with opts.titles or player.setTitles())
player.current           // PlayerTitle | null
player.play(id?)         // no argument: resume; an id: switch to that title and play it
player.pause()
player.toggle()
player.next()            // wraps at the end only with opts.loopList
player.back()            // restarts the current title if more than 3 s in, else the previous one
player.on('ended' | 'titlechange' | 'play' | 'pause' | 'timeupdate' | 'error' | 'detached', fn)
```

- `'ended'` keeps #73's behaviour: it also fires once for a listener attached after the clip ended.
- With `loop: false` a title ends, and the list does **not** auto-advance unless
  `opts.autoAdvance: true`. That is the no-loop path they asked for.
- Everything above behaves identically in both modes. The only mode-dependent behaviour is in
  the table below.

**Option parity:**

| Option | `addPlayer` | `attachPlayer` |
|---|---|---|
| `format` (`'sbs' \| 'tb' \| 'mono'`) | yes | yes (passed to `setVideo`) |
| `fit` (`'contain' \| 'cover'`) | yes | yes (passed to `setVideo`) |
| `band` | yes | needs `setVideo` to take a band (follow-up in `./splat`); warns and ignores until then |
| `transition: 'crossfade'` | yes | cut only, until `setVideo` crossfades (A2) |
| `posterFormat` | yes | n/a: the scene is on screen until the first frame |
| `skin`, `size`, `accent`, `title`, `skipButtons`, `keyboard` | yes | yes |
| `fullscreen` | default on | default off |

Controls that sit inside the letterbox bars need the plane's on-screen rect. For the splat
adapter that means `setVideo`'s result exposing the rect of the plane it drew (a small addition to
`./splat`), until which the bars layout falls back to the bottom of the tile.

### A5. Asks of `./splat`

None of these block surface mode v1. Each makes it match the canvas player more closely:

1. `setVideo(…, { transition, durationMs, easing })`, a GPU crossfade (A2).
2. `setVideo(…, { band })`, a letterbox slot of a target aspect (A4).
3. The plane's on-screen rect on `setVideo`'s result, updated on resize, for controls in the bars (A4).

### A6. Plan

- Split the player into a core plus two surface adapters. No behaviour change for `addPlayer`;
  existing tests stay green.
- `attachPlayer` with the splat adapter: `format`, `fit`, cut transitions, controls, keyboard,
  the playlist API, and `detach()`.
- The playlist API lands first in the canvas player (next PR), then carries over unchanged.
- **Acceptance on the panel:** in one app with a single persistent splat canvas, go to Watch
  (attach), play, go next/back by API and by voice-command stand-in, detach, and confirm the scene
  is restored exactly (pose, lens, rig). No second woven canvas is created at any point. Check
  the controls stay crisp over the woven canvas on a legacy browser (exclusion) and with
  draw-order occlusion.
- **Open questions for David:** whether A5.1 (GPU crossfade in `setVideo`) is acceptable in
  `./splat`, and whether `attachPlayer` should also accept a `model` handle later.

# Proposal: auto-3D in the DisplayXR Browser, on by default where a 3D display is present

| revision | date | what changed |
|---|---|---|
| r1 | 2026-09-26 (c4fdf5a, note added in 1db0a78) | shipped the prototype as a component extension, off by default, allowlist, kill switch |
| **r2** | 2026-09-27 | **this revision.** Default-on when a DisplayXR display is present, zero cost elsewhere. Adds a per-canvas "3D" chip, browser-side controls, and an injection mechanism that also works on Android. Updates the pre-flight list against the 2026-09-26/27 panel runs. r1 is kept at the end, with the parts this revision replaces marked. |

Status: **proposal, for decision.** The prototype is [`tools/auto3d-shim/`](../../tools/auto3d-shim/README.md)
(v0.4.0). Browser references are to the private fork `displayxr-browser-pvt` at `origin/main`
(4ecb8f0, Chromium 155), written `pvt:patches/NNNN:LINE` for a line in a patch file.

## Summary

The direction this answers:

> "how is the auto-3d enabled? is it per canvas? with a chip showing in the canvas to
> enable/disable? ... I really like it, I think it should be part of the DXR browser default
> experience if well designed. Should cause zero penalty for non-DXR devices; if the DXR runtime is
> detected then it shows."

**Today** the prototype is a hand-loaded unpacked extension. Wherever it is loaded it converts every
qualifying three.js or PlayCanvas canvas on every site. The unit is **one canvas per document**, the
switch is **per origin**, it is stored in the **page's own `localStorage`**, and it is controlled by
`Ctrl+Alt+` hotkeys plus a monospace HUD. There is no browser UI.

**Recommendation.**

1. **UX.** auto-3D is a browser feature, on by default *only when a DisplayXR display is present*.
   A converted canvas gets a small **"3D" chip** in one corner. The chip turns 3D off or on for the
   site and opens a menu for depth and rig. The chip is a plain quad in the top layer, so it is never
   woven and never moves page layout. The **authoritative** controls live in browser chrome: a 3D
   icon in the address bar with a bubble, a Page Info row, and a Settings page with per-site
   exceptions. The page cannot reach or forge these. The `Ctrl+Alt` hotkeys go away (they eat AltGr
   characters on European keyboards, §1.5). A page the SDK already made 3D shows no chip. A page
   that stays 2D (WebGPU, post-processing) shows nothing in the page, and a muted address-bar icon
   explains why.
2. **Architecture.** The scripts are injected at `document_start` by the **renderer itself**. The
   renderer reads a new `auto_3d` content setting that the browser pushes with the renderer's
   configuration, and on a machine with no DisplayXR display that setting is `BLOCK` for every site.
   "No display" is known at startup, before the first renderer, from a static check that no DisplayXR
   runtime is installed and active (§3.1).
   So **nothing is injected, parsed or hooked on a non-DisplayXR machine**. The cost there is one
   branch per document. The same mechanism works on Android, where the component-extension route of
   r1 does not exist (Android builds no extension system). The content setting also gives us
   per-site exceptions, Page Info and enterprise policy with standard Chromium plumbing.
3. **Cost on a DisplayXR machine.** Measured today: about **4.8 ms of script evaluation per frame**,
   in every frame including ad iframes, plus a global `Element.prototype.id` hook. Reads of
   `canvas.id` get 5x slower and reads of `div.id` 1.3x. The target is a ~4 KB sentinel that arms
   hooks only on a page that creates a WebGL context. Everything else is evaluated lazily, only once
   an engine is found.
4. **Rollout.** In the first release, auto-3D converts automatically on an allowlist and elsewhere
   *offers* 3D: the chip says "3D" and one click converts. The default flips to automatic everywhere
   once a no-harm corpus passes (§3.9). This is the same data gate as r1, with a better
   experience while it is being collected.

```
                     non-DisplayXR machine                 DisplayXR machine
                     ---------------------                 -----------------
browser start   ->   stage 0: no runtime -> ABSENT         stage 0: runtime -> UNKNOWN
                     (before the first renderer)           stage 1 (~2-4 s): PRESENT
content setting ->   auto_3d = BLOCK, every site           auto_3d = the user's site rule, else
                                                           ALLOW (allowlist) / ASK = offer (rest)
renderer        ->   one branch, nothing injected          sentinel (~4 KB) at document_start
page with no WebGL   -                                     sentinel only, no hooks armed
page with an engine  -                                     core + adapter evaluated -> chip -> 3D
```

---

## 1. Today's UX (v0.4.0), precisely

### 1.1 How it is enabled

- **Delivery.** It ships as an unpacked MV3 extension with three `MAIN`-world content scripts on
  `<all_urls>`, at `document_start`, in `all_frames` (`tools/auto3d-shim/manifest.json`). You load
  it by hand from `chrome://extensions` or with `launch.cmd` (`--load-extension` into a separate
  profile, `launch.cmd:10-17`). Nothing in the browser knows about it.
- **Gate.** `core.js` goes inert unless `window.XRDisplayLayer` and `navigator.xr` exist
  (`core.js:30`). In the DisplayXR Browser that is **always** true, on any machine:
  `DisplayXRInline3D` is a *stable* Blink feature (`pvt:patches/0042:81-88`). So the gate means "this
  is the DisplayXR Browser", not "there is a 3D display". The first display check comes after a layer
  is created: `probeDisplay()` gives up when `getDisplayInfo()` is null and no rendering modes are
  reported (`core.js:410-427`).
- **Default.** On for every site: `DEFAULTS.enabled = true` (`core.js:47`). r1's allowlist was
  never built. Any page with a detected engine and a qualifying canvas converts.
- **Detection.** three.js through a `__THREE_DEVTOOLS__` accessor defined before any page script
  (`three-adapter.js:42-69`). PlayCanvas through a `window.pc` accessor, a 20 s poll of
  `window.app`, and a canvas-`id` trap on `Element.prototype` for ESM builds
  (`playcanvas-adapter.js:112-164`).

### 1.2 The unit of conversion

**One canvas per document.** `owner` is the one canvas converted (`core.js:107`), and
`considerActivation` returns early while there is one (`core.js:201`). A canvas qualifies when it
is in the document, at least 120 CSS px on each side, on screen (`core.js:53`, `:213-219`), and
free of any CSS effect on itself or an ancestor (woven-canvas rule 7, `core.js:221-234`). The
adapter adds its own conditions: one perspective camera, no post-processing chain, WebGL
(`README.md`, "What each adapter converts"). Each frame is its own document with its own state, so
the PlayCanvas examples browser (an iframe) converts inside the iframe.

### 1.3 What shows

- **Cover.** An `<img>` still of the last mono frame over the canvas for 1.2 s after the layer
  (`core.js:737-780`, `holdMs` `:54`). The depth then fades in over 500 ms (`rampMs` `:56`).
- **HUD.** A fixed monospace line at the bottom left, z-index 2147483647, `pointer-events:none`
  (`core.js:861-868`), for example `DXR auto-3D ● camera rig · depth 0.30 · conv 8.00 (target) ·
  3D 812 · flat 0 · replay 0`. It is visible whenever a canvas is converting or live, standing down,
  or flat for a structural reason (`core.js:852-882`). It is a tester's readout, not product UI.
- **Console.** `[dxr-auto3d]` lines, `window.__dxrAuto3D.state()` / `.probe()`
  (`core.js:903-942`).

### 1.4 How to turn it off

- **Per site.** `Ctrl+Alt+3` toggles `cfg.enabled` for this origin. The depth fades out, the
  out-cover goes up, a mono frame is drawn, and the layer is released
  (`core.js:383-404`, `:887`).
- **Everywhere.** Remove the extension. There is no global switch, no kill switch and no policy.
- **From the page.** `window.__dxrAuto3D.set('enabled', false)` works, and so does any other key
  (`core.js:906`). Any page script can call it.

### 1.5 What persists, and where

| state | where | scope | who can read / write it |
|---|---|---|---|
| `{v, enabled, depths{camera,display}, convScale, rig, hud}` | the page's `localStorage['dxrAuto3D']` (`core.js:62-84`) | the **frame's** origin: an embedded example's setting lives under the iframe's origin, not the tab's | **the page**: it can read the user's choice and depth, and change or clear them |
| everything else (convergence, counters, which canvas) | memory, per document | until navigation | the page, through `window.__dxrAuto3D` |

Two findings from this read that a default-on build must fix:

- **The hotkeys steal typed characters on European keyboards.** The listener runs in capture phase
  on every page the scripts load on, whether anything was converted or not. It calls
  `preventDefault()` + `stopImmediatePropagation()` on `Ctrl+Alt+{3,P,=,-,0,9,8,D}`
  (`core.js:883-897`). On Windows, AltGr is reported as Ctrl+Alt. On a German layout, AltGr+8/9/0/ß
  type `[ ] } \`, so those characters stop working in every text field on the web. French and
  other layouts lose other characters.
- **The page sees the feature.** `'pc' in window` becomes `true` on every page
  (`playcanvas-adapter.js:116`, measured, §3.3). `navigator.xr.requestSession`,
  `Element.prototype.id` and `window.__THREE_DEVTOOLS__` become non-native accessors or wrappers.
  `window.__dxrAuto3D` exposes the user's settings. That makes the feature a fingerprint surface
  and gives pages a way to break it by accident.

---

## 2. Proposed UX (default-on when a DisplayXR display is present)

### 2.1 The unit of control

There are three levels, and each one does one job:

| level | what it holds | where it lives | set from |
|---|---|---|---|
| **global** | auto-3D on / off; default depth preset | browser profile setting | Settings |
| **per site** | allowed / blocked; depth per rig; rig; convergence scale | browser content setting + per-site website setting (never the page) | chip, address-bar bubble, Page Info, Settings |
| **per canvas** | "this canvas, right now" | memory, per document | chip (only while the page is open) |

**Why the per-site level is the sticky one.** David asked whether it is per canvas. Visually yes:
the chip sits on the canvas it controls. The choice it remembers is per site, for three reasons:

- A canvas has no identity that survives a reload. Canvas ids are optional and bundlers regenerate
  them, and the DOM path changes with the page's own state.
- One inline-3D session per document is a rule a page must keep (woven-canvas rule 1): the
  element-rect channel is one whole-widget list, so two live sessions overwrite each other every
  frame. The browser does not refuse a second session; it just weaves wrongly. So at most one canvas
  per document is converted (§1.2), and "this canvas" and "this page" are the same thing today.
- What people mean by "turn 3D off" is "on this site". If a reload brought 3D back, the switch
  would feel broken.

Options for what the chip's toggle does:

| option | chip click | remembered |
|---|---|---|
| **A (recommended)** | on/off for the site | yes, per site (the top-level site, with the embedded origin for iframes, as Chromium's content settings key them) |
| B | on/off for this page view only; "always" lives in the menu | no, unless chosen in the menu |
| C | on/off for this canvas; site default from Settings | no |

A matches the mental model and today's behaviour. B is safer on a site where one page is good and
another bad, but it makes the common case two clicks. C gives exact control that cannot be kept.
**Recommend A**, with "Just this time" as a menu item for B's case.

**Keying.** Today a setting is stored per *frame* origin (§1.5). A content setting is keyed
by the top-level site plus the embedded origin. So a user who turns off 3D on the PlayCanvas
examples page turns it off for the embedded example there, which is what they meant.

### 2.2 The "3D" chip

```
+------------------------------------------------ canvas (woven) ---+
|                                                   .-----------.    |
|                                                   | 3D  ●  v  |    |  <- expanded, 3 s after the
|                                                   '-----------'    |     cover drops, then collapses
|                                                                    |
|                    the page's 3D scene                             |
|                                                          .----.    |
|                                                          | 3D |    |  <- collapsed (default state)
+----------------------------------------------------------'----'----+
```

**Where it sits.** Top-right corner of the converted canvas, inset 8 px. If that spot is taken by
the page's own UI (the topmost element at the chip's box is not the canvas), try bottom-right,
top-left, bottom-left. If all four are taken, show no in-canvas chip and rely on the address-bar icon.
The chip is **never** placed over page UI, so it never takes a click the page expected there.

**How it is built** (the three constraints: never woven wrong, never breaks layout, never steals
page input):

| constraint | how |
|---|---|
| **not woven** | Precedent: the immersive-vr HUD is exactly this, a browser-owned element inside the page, kept small at an edge because "a full-tile element over the canvas would evict it from the weave input" (`pvt:patches/0169:6-21`). A small, opaque-enough, plain quad. The fork occludes the woven region **by draw order** (`pvt:patches/0063`–`0065`, default on for Windows in `0065` and for Android in `0105`), so a plain element over the tile composites as crisp 2D with nothing declared ([authoring, 2D over 3D](../authoring-inline-3d.md#2d-over-3d--draw-order-occlusion)). The chip is at most 64×28 CSS px and the smallest convertible canvas is 120 px, so the chip is **always a partial region** ([rule 8](../woven-canvas-rules.md#8-chrome-over-a-woven-canvas-is-a-partial-region)). **No `opacity`, `filter`, `backdrop-filter`, blend mode or 3D transform** on it or its host. The split lifts only plain quads, and a render-surface element would be woven with the tile ([§5 pitfall 1](../woven-canvas-rules.md#5-pitfalls-from-production-september-2026)). "Fading" means animating the **background and text colour alpha**, which stays a plain quad, never `opacity`. Hidden with `display:none` (rule 8). |
| **no layout change** | Not inserted next to the canvas: siblings change `:last-child`, `+` selectors and flex/grid flows. One host element on `document.documentElement`, promoted to the **top layer** (`popover="manual"` + `showPopover()`), so page stacking contexts, `overflow` clipping and `z-index` cannot bury or clip it. It is positioned from the canvas's `getBoundingClientRect()` on every session frame, a loop that already runs (`core.js:443`). The cover `<img>` still goes in as a sibling, as today. It is congruent with the canvas and has to be in the canvas's stacking context. |
| **no stolen input** | The host is `pointer-events:none` and only the pill is `auto`, the same pattern as the immersive HUD (`pvt:patches/0169:19-21`). A closed shadow root, and every pointer, wheel and key event on the pill is stopped inside it, so a page's `OrbitControls` (which listens on `document` for moves) never sees a drag that started on the chip. The chip is re-placed when the page opens a modal over the canvas: the hit test above fails and it hides. |

**Lifecycle.**

| moment | chip |
|---|---|
| engine found, canvas qualifies, site **allowed** | nothing during the 1.2 s cover. It appears **expanded** (`3D ●  ⌄`) as the depth fades in, then collapses after 3 s |
| engine found, canvas qualifies, site in **offer** mode (first release, §3.9) | collapsed `3D` pill, outlined, not filled: "3D available". One click converts |
| live, pointer over the canvas | collapsed pill stays; hovering the pill expands it |
| turned off by the user | pill switches to outlined `3D` (click turns it back on) for 5 s, then collapses to the outline only |
| pointer idle for 3 s over a fullscreen canvas | pill hides (`display:none`) and comes back on pointer move. A fullscreen 3D view should be clean |
| structural 2D (WebGPU, post-processing, several cameras), SDK page, no display | **no chip** (§2.5) |

**Look.** A dark pill, `rgba(16,17,22,.85)` background, 1 px `rgba(255,255,255,.35)` border,
white 12 px system-UI text `3D`, and a 6 px status dot (green: woven; amber: converting or waiting
for eyes; outline only: off). No shadow, no blur. It is the same visual family as the address-bar icon,
so they read as one feature.

**The menu** (click the caret, or right-click the pill): a small popover under the pill, also in the
top layer, and also smaller than the tile:

```
.-----------------------------------.
| 3D on this site           [ on ]  |
| Depth       ----o-------  0.30    |
| Style   (o) Scene camera          |
|         ( ) Object on the glass   |   <- display rig
| Focus   [nearer] [auto] [farther] |   <- convergence
| Just this time (don't remember)   |
| auto-3D settings...               |
'-----------------------------------'
```

"Scene camera" and "Object on the glass" are the camera and display rigs in words a user
understands. The depth slider moves the active rig's depth, with the ranges and defaults of v0.4.0
(camera 0.30, display 1.00, `core.js:41`). A change applies live and is written to the per-site
setting through the browser (§3.5), never to the page.

### 2.3 Browser-chrome affordances (the trusted surface)

The chip is a convenience inside the page's world. A page can cover it, restyle its host or remove
it, even though it cannot read into it (§3.7). So everything the chip does is also available from
browser UI, and the browser UI is the authority:

| surface | what | notes |
|---|---|---|
| **address-bar icon** (desktop), like the cast and Picture-in-Picture icons | shown when a page has a converted canvas (filled icon), an offer (outlined), or a structural 2D reason (muted). Its bubble holds the same controls as the chip menu, plus the reason when 2D | the keyboard-accessible, unforgeable control. New ground: no DisplayXR UI exists in browser chrome today, the fork touches no `ui/views` code (`pvt:patches/0129:20-22`) |
| **Page Info** (the lock-icon bubble) | a "3D conversion: Allow / Block / Offer" row | comes with the content setting |
| **app menu** | "View in 3D" check item for the current tab | desktop 3-dot menu; Android overflow menu |
| **Settings > Privacy and security > Site settings > 3D conversion** | global default (Automatic / Offer / Off), default depth preset (Gentle 0.2 / Standard 0.3 / Strong 0.5 on the camera rig), per-site Allow / Block lists | shown only when a DisplayXR display has ever been detected on this profile. Otherwise hidden, so a non-DisplayXR user never sees a feature they cannot use |

A browser bubble on Windows is its own top-level window that DWM composites **above** the woven
browser window, so it is viewed through the lenticular and ghosts. The fork already flattens the panel
under omnibox dropdowns, autofill and menus through the sticky flat-region channel
(`pvt:patches/0069:7-23`). The auto-3D bubble has to be registered with that same tracker, or it
reads soft.

### 2.4 First-run discovery

The first time a page converts on a profile, the chip stays expanded until the first pointer
interaction or 8 s, with one line under it: *"Shown in 3D automatically. Click to turn off for this
site."* A profile preference records that it was shown, and it is never shown again. There is no
infobar (it shifts page layout), no modal, and no tab opened.

The browser's start page (the samples index, `pvt:patches/0132`, `branding/initial_preferences`)
gets a "3D on the web" card that links to a converted three.js example. That page is ours, so the
discovery costs no third-party page anything.

### 2.5 Pages that stay 2D

| page | today (v0.4.0) | proposed | why |
|---|---|---|---|
| **SDK page** (it requests `inline-3d` itself) | stands down for the document; the HUD says "standing down" (`core.js:118-127`) | **silent.** No chip, no address-bar icon | the page owns its 3D, and its own UI is the right UI. A chip there would compete with the author's controls |
| page requests `immersive-vr` / `immersive-ar` | stands down | silent | the immersive path owns it (now Blink-native, `pvt:patches/0183`) |
| **WebGPU** renderer | 2D, HUD reason | **no chip. Muted address-bar icon**; the bubble says "This page draws with WebGPU. 3D conversion supports WebGL pages." | in-page UI on a page that will never convert is clutter. The muted icon answers "why isn't this 3D?" for the user who looks |
| **post-processing** / several cameras / orthographic | 2D, HUD reason | same as WebGPU, with the reason | same |
| no DisplayXR display | inert after a failed probe | nothing is injected (§3.3) | zero penalty |

The alternative is to say nothing at all, not even the muted icon. That is quieter, but "some
three.js pages are 3D and some are not, for no visible reason" becomes a support question. **Recommend
the muted icon**, with a setting to hide it.

### 2.6 Controls: from hotkeys to the chip

| today (`core.js:883-897`) | proposed |
|---|---|
| `Ctrl+Alt+3` on/off | chip click; address-bar bubble; one **browser** accelerator, `Ctrl+Shift+3`, registered in the browser's accelerator table so the page never sees it and AltGr is not involved |
| `Ctrl+Alt+P` rig | chip menu "Style" |
| `Ctrl+Alt+=` / `-` depth | chip menu slider |
| `Ctrl+Alt+0` / `9` convergence | chip menu "Focus" |
| `Ctrl+Alt+8` reset | chip menu, "Reset" under the slider |
| `Ctrl+Alt+D` HUD | gone from the product. The HUD survives behind a developer switch (§3.10) |

The in-page hotkeys stay only behind `--auto-3d-dev-hotkeys`, for testers who already know them.

### 2.7 Accessibility and keyboard

- The pill is a `<button>` with `aria-pressed` and a full label (`"3D view: on. Turn off for this
  site"`). The menu is a `role="menu"` popover with arrow-key navigation, `Escape` to close, and focus
  returned to the pill.
- The pill is **not** in the page's tab order (`tabindex="-1"`). Inserting a tab stop into a page we
  do not own changes that page's keyboard flow. The keyboard route is the browser's: the address-bar
  icon is reachable with the toolbar's focus cycle (F6 / `Alt+Shift+T`), and `Ctrl+Shift+3` toggles.
- `prefers-reduced-motion`: no depth fade-in (the cover drops straight to full depth) and no chip
  expand animation.
- The status dot is never the only signal: the text and `aria-pressed` carry the state, and the
  outline vs filled pill differs in shape, not just colour.
- Screen readers: when a canvas converts, the chip announces once through a polite live region
  ("3D view on"). Nothing is announced on pages that stay 2D.

---

## 3. Architecture

Hard requirement: **zero penalty on a machine without a DisplayXR display.** Nothing is injected,
parsed, hooked or shown there.

### 3.1 Detection: where, and how early

**What the browser knows today, and when.** There is no observable "a DisplayXR display is present"
state in the browser.

- **Windows.** The browser-process weave client starts from a 2 s delayed task after
  `PostBrowserStart` (`pvt:patches/0007:183-188`). That is after profile and extension init, and
  usually after the first renderer. It retries every 500 ms for up to 60 s
  (`pvt:patches/0019:26`, `0071:541`). Its result is a per-process static
  (`IsSupportedWin()`) that nothing else can subscribe to.
- **Android.** The session lives only in the GPU process (`pvt:patches/0086:142`).
- **What a page sees.** `isSessionSupported('inline-3d')` asks the browser fresh each time
  (`pvt:patches/0006:1703-1714`). `requestSession('inline-3d')` always resolves, display or not
  (`0006:1677-1681`). `getDisplayInfo()` is null until the session is live, and **always null off
  Windows** (`pvt:patches/0127:152,911`).

The cases a presence signal has to tell apart:

| machine | what happens today | presence should read |
|---|---|---|
| no DisplayXR runtime (or a foreign OpenXR runtime is active) | the loader enumerates, finds no `XR_DXR_weave`, latches `kUnavailable`, answers probes false (`pvt:patches/0001:224,248`, `0077:427-431`) | **absent**, immediately |
| runtime installed, no 3D panel | nothing checks for a real panel. If the runtime's fallback display processor yields a session, the browser reports "supported" | **absent**. This needs a runtime fact: whether the active display processor drives a real panel. If `XR_DXR_display_info` does not carry it today, it is a small runtime ask |
| second browser instance (browser#162) | `XR_ERROR_LIMIT_REACHED` is treated as transient: 60 s of retries, then every `isSessionSupported('inline-3d')` waits its full 5 s deadline before answering false (`pvt:patches/0077:231`) | **absent**, and the browser should classify -10 as final |
| runtime started, or panel connected, after launch | Windows never re-probes after a cold start without a runtime; the reconnect ladder arms only after a session existed (`pvt:patches/0077:691`). Android keeps retrying for ~82 s (`0190:765,791`) | inherits today's behaviour: a relaunch on Windows |

**Proposal: a two-stage presence state in the browser process** (`unknown` / `absent` / `present`, observable):

1. **Stage 0, synchronous, at startup.** A cheap static check that a DisplayXR runtime is installed and active:
   - Windows: the OpenXR `ActiveRuntime` registry value points at DisplayXR's manifest;
   - Android: the runtime package is installed.

   No runtime means **absent** before the first renderer starts. That is the non-DisplayXR machine,
   so the hard requirement is met here, at startup, without waiting for anything.
2. **Stage 1, asynchronous.** The weave client's answer, plus the real-panel fact, moves the state to
   `present` or `absent` (on Windows about 2–4 s after start). On Android, the GPU-restart events
   that already push support changes (`pvt:patches/0189:228-235,296`) drive it too.

The injector reads the state through the content setting (§3.2):

| presence | `auto_3d` for every site |
|---|---|
| **absent** | forced `BLOCK` |
| **present** | the user's rules |
| **unknown** (runtime installed, not yet answered) | the user's rules. A session-restore tab that loads in the first two seconds still converts, and the shim's own probe (`core.js:410-427`) stands it down if there is no display after all |

Only machines with the runtime installed ever pay for that window.

**Related finding, outside auto-3D.** The browser already charges non-DisplayXR machines at startup.
The Windows GPU process blocks in `PreSandboxStartup` for up to 32×250 ms = 8 s waiting for the
browser window ("typical 1-3 s") *before* it learns there is no runtime (`pvt:patches/0023:347-350`).
Stage 0 would let it skip that wait. This is worth its own browser issue.

### 3.2 Injection: three options

| | **A. component extension, added only when present** | **B. renderer document-start injector + content setting (recommended)** | C. static component extension + in-script gate (r1) |
|---|---|---|---|
| mechanism | `ComponentLoader::Add` called **after** presence is known, never on a non-DisplayXR machine; MAIN-world content scripts as today, plus an ISOLATED-world bridge for storage | `ChromeContentRendererClient::RunScriptsAtDocumentStart` evaluates the vendored scripts in the main world when the frame's `auto_3d` setting is not `BLOCK`. The script source is in the resource bundle. The per-site decision reaches the renderer with the renderer's configuration, as other content-setting rules do | the extension is always loaded; the script decides |
| non-DisplayXR cost | none (never added) | one branch per document | **~4.8 ms parse per frame, every page, forever** |
| Android | **not available**: Android builds no extension system (`pvt:docs/design/immersive-vr-android.md:143,161-164`) | same code on both | not available |
| per-site state | `chrome.storage` is not reachable from the MAIN world; needs an ISOLATED-world relay through DOM events, which the page can observe and forge | the browser owns it; the renderer receives the decision before the script runs, and the script gets a small private capability object for writes (§3.5) | page `localStorage` |
| policy / Page Info / Settings exceptions | hand-built | **standard, from the content-settings registry** | hand-built |
| rebase surface | small, and already proven by 0134 | larger: renderer client, content-settings registry, renderer configuration (upstream-churny files, so more weave-gate HOLDs unless the gate classifies them as non-weave) | small |
| page can detect it | yes (same scripts) | yes (same scripts); the private capability never lands on `window` | yes |

**Why not C:** it fails the hard requirement. **Why not A:** it leaves Android on a different
mechanism, and its storage bridge is page-forgeable. The immersive-vr precedent argues the same way from
the other side. Its Android design rejected a document-start injection because a Blink-native path
existed (`pvt:docs/design/immersive-vr-android.md:159-171`). auto-3D has no native equivalent: its
job is hooking engine JavaScript, which changes with every three.js and PlayCanvas release. So
injection is the right mechanism, and it should be one mechanism on both platforms. **Recommend B.**
A is an acceptable Windows-only interim if P1 has to ship before the renderer work is ready. It
reuses 0134's plumbing (`pvt:patches/0134:142-160`, allowlist `:134`).

### 3.3 Costs

**On a non-DisplayXR machine (option B):** no script is evaluated and no hook installed. The content setting is
`BLOCK` for every site, so `RunScriptsAtDocumentStart` returns after one lookup. No preference or
settings UI is shown (§2.3). The browser process pays the presence detection it already does
(§3.1) and nothing more.

**On a DisplayXR machine, a page with no three.js or PlayCanvas: measured today, and the target.**

Measured on 2026-09-27: headless Chrome, an M1 Pro, a page with 2,000 elements and no engine. The
three scripts were injected at document start, as the extension does, with a stubbed `XRDisplayLayer`
so the core arms. Median of 5:

| | without | with v0.4.0 | note |
|---|---|---|---|
| script evaluation at document start | 0 | **4.8 ms** | 112 KB unminified, no code cache; paid in **every frame** (`all_frames`), including ad iframes |
| 500k `div.id` reads | 48 ms | 64 ms (+33%) | the global `Element.prototype.id` getter (`playcanvas-adapter.js:156`) runs on every element |
| 500k `canvas.id` reads | 5.6 ms | 28 ms (5x) | plus the `Object.prototype` trap bookkeeping |
| `'pc' in window` | false | **true** | page-observable (`playcanvas-adapter.js:116`) |
| timers | none | 40 polls over 20 s per frame | `playcanvas-adapter.js:124-126` |

A product build cuts this to a **sentinel**:

- ~4 KB, evaluated at document start;
- defines `__THREE_DEVTOOLS__` (three.js checks for it with `typeof`, and it must exist before three
  loads);
- wraps `HTMLCanvasElement.prototype.getContext`, and nothing else;
- on the first `webgl` / `webgl2` context, arms the PlayCanvas routes: the `pc` accessor, the poll,
  and an `id` trap **on that canvas instance only** instead of on `Element.prototype`. PlayCanvas
  creates its graphics device on the canvas before the `AppBase` constructor reads `canvas.id`, so
  the ESM route still works;
- evaluates core + adapter (~110 KB) only when an engine is actually announced.

Estimate for a page without WebGL: under 0.3 ms per frame, no global prototype hooks, and nothing
page-visible except `__THREE_DEVTOOLS__`. That one is the same object the three.js devtools extension
installs, so its presence is not specific to us.

**On a converted page:** every converted draw runs twice (one per eye), plus a per-frame
`setViewRig` and a scene walk every 30 frames for convergence (`core.js:479`). Pages have run at
60 fps on the panel (2026-09-26). A default-on build needs a **frame-rate guard**: sustained frame
time over budget (for example under 40 fps for 2 s after the fade-in) returns the page to 2D with
the reason in the bubble. v0.4.0 has no such guard.

### 3.4 Where the scripts live

- **Source of truth stays `displayxr-web/tools/auto3d-shim/`**, as r1 said. The browser vendors
  the built artifacts verbatim. A browser-side edit is a bug: fix here, re-vendor, recapture
  (`pvt:docs/integration-points.md:675-690`, the 0134 rule).
- **New here:** a tiny build step (concatenation plus a version stamp, still no bundler) that emits
  `dist/auto3d-sentinel.js` and `dist/auto3d-core.js`, plus a `VENDOR.json` recording the source
  commit and a content hash. The browser patch records the same hash, so drift is detectable
  mechanically. Today no script re-vendors the immersive shim (it is copied by hand).
- **Cadence:** the scripts ride the browser release. That is every Chrome stable point release,
  auto-published when the weave gate passes and held for a hardware check when it does not
  (`pvt:docs/maintenance-policy.md:13-27`), so in practice every 1–2 weeks. There is no faster
  hot-fix channel, and this proposal does not add one. The kill switch and the policy (§3.8) are the
  fast path.

### 3.5 State: from page `localStorage` to the browser

| item | today | proposed |
|---|---|---|
| on / off / offer | `localStorage.dxrAuto3D.enabled`, frame origin | content setting `auto_3d` (ALLOW / BLOCK / ASK = offer), keyed top-level site + embedded origin |
| depth per rig, rig, convergence scale | `localStorage`, frame origin | a website setting (per-site data, not a permission) for the same key |
| first-run shown | none | profile preference |
| global default, depth preset | none | profile preferences |

**How the script reads and writes.** Before the core runs, the injector hands it one argument: a frozen
`{ decision, depths, rig, convScale }` for this frame, plus a capability object with two functions,
`save(partial)` and `report(state)`. The capability is a native binding created per frame and
passed as a function argument, not put on `window`, so page code cannot reach it unless our script
leaks it. The browser **validates** every write: the key is the frame's real origin as the browser
knows it, never one the script names, and the values are clamped (depth 0.02–1, rig in a fixed
set). `window.__dxrAuto3D` and all `localStorage` use go. A diagnostics object is exposed only
under the developer switch (§3.10).

A one-time **migration** of v0.3/v0.4 `localStorage` values is not worth doing: only testers have
them.

### 3.6 Privacy

The scripts run in the page's own world on every allowed page, so they see what the page sees. What
they do with it:

- **Nothing leaves the renderer.** There are no network requests and no telemetry. The only data that
  crosses to the browser is the `save()` write (a site's depth and rig) and a `report()` of
  `{engine, converted, reason}` for the address-bar icon. No URLs beyond what the browser already has,
  and no scene content.
- **Pixels.** The out-cover reads the page's own canvas back (`core.js:789-827`) and puts it in
  the page's own DOM. The page already had those pixels.
- **What a page can learn about the user:** that auto-3D is active, and that it converted the canvas
  (it can infer this from the canvas store size or a hooked prototype). In v0.4.0 it can also read the
  user's per-site choices and depth; the proposal removes that. The browser already reveals a
  3D display to any page that calls `isSessionSupported('inline-3d')`, and its release through UA-CH
  (`pvt:patches/0245`). So auto-3D adds no new *class* of fingerprint, but it should not add
  **user preferences** to it.
- **Frames.** The sentinel runs in cross-origin iframes too, because examples and embeds live there.
  Each frame's decision comes from its own content-setting key, so a blocked embed stays blocked
  inside an allowed top-level page.

### 3.7 Security: the threat model

MAIN world means the page can tamper with the shim: redefine prototypes it calls, spoof engine
objects, call hooks out of order. The model is:

| threat | stance |
|---|---|
| page uses the shim to gain a capability | **not possible by construction**: the shim uses only the public inline-3D API the page already has, with the page's own privileges. The one private capability (`save`/`report`) is scoped by the browser to the frame's real origin and clamped |
| page forces 3D on for itself | allowed: the page could request `inline-3d` through the SDK anyway |
| page forces 3D **off** for itself, or opts out | allowed and wanted: add a documented opt-out, `<meta name="displayxr-auto3d" content="off">`, read by the sentinel |
| page keeps 3D on after the **user** turned it off | must not be possible. The user's off switch lives in browser UI (§2.3) and takes effect in the browser: it ends the document's inline-3D session from the browser side and stops injection on the next load. It never depends on page-world code |
| page hides, covers or spoofs the chip (clickjacking a fake "3D" pill) | low stakes (the worst outcome is a 3D toggle on that site), and the trusted surface is the address-bar icon. The chip lives in a closed shadow root in the top layer, so a page cannot restyle what is inside it |
| page crashes the shim or makes it misbehave | contained: the shim runs inside `try` blocks and stands down to 2D. Worst case is a page that renders flat or badly, which the page could do anyway. The frame-rate guard (§3.3) caps a runaway double draw |
| excessive disparity / discomfort | clamped twice: the shim (`DEPTH_MAX` 1, `core.js:42`) and the runtime (display-rig factors `[0,1]`, camera-rig comfort ≤ 1). The runtime's temporary widening above 1 (README "Rigs") must not reach a release that has auto-3D on by default |

### 3.8 Kill switch, policy, updates

- **Kill switch:** `--disable-auto-3d` (both platforms, read in `BasicStartupComplete` beside the
  existing DisplayXR switches). It forces the content setting to `BLOCK` for every site and hides the
  UI. Mind the repeated bug class: both the Windows **and** the Android arms of the startup block
  must read it (`pvt:patches/0105`, `0186`).
- **Enterprise policy:** `DefaultAuto3dSetting` (1 allow, 2 block, 3 offer),
  `Auto3dAllowedForUrls`, `Auto3dBlockedForUrls`. This is the standard shape for a content-settings
  policy, and the fork adds its first policy templates with it (there are none today).
- **Field fallback without a rebuild:** the kill switch, plus a per-engine switch
  (`--disable-auto-3d-engines=playcanvas`) for the case where one adapter misbehaves on a new engine
  release before a browser release can fix it.

### 3.9 Rollout policy: allowlist, then offer, then automatic

| stage | automatic on | offer (chip "3D", one click) on | gate to the next stage |
|---|---|---|---|
| **1 (first release)** | the compiled-in allowlist: engine example sites, our demos, hand-tested hosts | every other site where an engine is detected and the canvas qualifies | the no-harm corpus below |
| **2** | every site | — | — |

**The no-harm corpus** is what flips the default. It needs 50 three.js sites and 20 PlayCanvas sites
from outside our own properties: product viewers, portfolios, configurators, games, the engines'
showcases. Each is run automatically (the harness in `tools/auto3d-shim/test`, pointed at live URLs)
and on the panel for a sample. The pass bar is **no harm**, not "good 3D":

- the page loads and its controls work, including raycast picking against the virtualised
  `canvas.width` and the page's own screenshot or export features;
- no new console errors;
- the frame rate stays above the guard, or the page drops to 2D cleanly;
- turning off returns the page intact.

"Good 3D" (comfort, convergence) is a quality metric that decides the allowlist, not the default.

### 3.10 Telemetry and diagnostics

**No telemetry is proposed.** Coverage data comes from the corpus runs (§3.9), not from users.
Local-only diagnostics:

- The address-bar bubble's "Details" line shows engine, detection route, rig, depth and the 2D
  reason. An internals page is out of scope.
- `--auto-3d-dev` switch: restores the HUD, the hotkeys and `window.__dxrAuto3D` for testers.
- The console `[dxr-auto3d]` lines stay (they are local), at `console.info` level.
- The browser's existing `[DisplayXR] inline-3D withheld …` log lines (`--enable-logging --v=1`)
  remain the source of truth for the join ([woven-canvas rules §3](../woven-canvas-rules.md#3-verifying-a-new-screen-on-hardware)).

### 3.11 Android

- **Injection:** option B works unchanged. Option A does not exist on Android (§3.2).
- **Presence:** see §3.1. The Android support answer can go stale across a GPU-process restart, and
  the browser now pushes changes to renderers (`pvt:patches/0189`). The content-setting push must
  follow the same events, so a document created after the weave is lost gets `BLOCK`.
- **The chip is the first touch UI in the fork.** The immersive path's control surface is keyboard
  and pointer-lock only ("No touch path anywhere", `pvt:docs/design/immersive-vr-android.md:139`).
  The chip needs a 44 dp minimum target. Its menu opens on tap, not hover, and the "idle hide" rule
  becomes "hide 3 s after the last touch". Hit-testing and geometry must live in the surface space that
  `0136` lays the page out in, inside the OEM mini-window.
- **No address-bar page actions on Android.** The trusted surface there is the overflow menu item
  ("View in 3D") and Page Info.
- **Texture limits.** Adreno reports `MAX_TEXTURE_SIZE` 4096 ([§5, last
  pitfall](../woven-canvas-rules.md#5-pitfalls-from-production-september-2026)). `realSizeFor`
  caps width at 3072 (`core.js:52`, `:170-179`) but not height. A portrait tablet canvas must be
  clamped on both axes against the GL limits, as the SDK does.
- **Input:** the adapters do not touch input, so touch orbit controls keep working through the
  converted canvas.
- **The shim's own display probe is weaker on Android.** `getDisplayInfo()` is always null off
  Windows (`pvt:patches/0127:911`), so `probeDisplay()` (`core.js:410-427`) rests on
  `getRenderingModes()` alone there. If that is also empty on Android, the shim stands every canvas
  down as "no display". The browser presence state makes this probe a fallback. Verify it on the
  tablet in P3 before relying on it.

---

## 4. What must be true before default-on

| # | item | status | evidence / what is left |
|---|---|---|---|
| 1 | **Zero penalty on non-DisplayXR machines** (injection gated on presence) | **not started** | §3.1–3.3. Blocking |
| 2 | **No page-visible settings; no in-page hotkeys** (AltGr collision) | **not started** | `core.js:62-84`, `:883-906`. Blocking |
| 3 | **Per-engine hardware sign-off** | **partly done** | Done: 2026-09-26 (v0.2.0) both engines convert at 60 fps and read well; 2026-09-27 (v0.3.0 + transitions) 2D→3D and 3D→2D clean on three.js `webgl_animation_keyframes` and PlayCanvas `gaussian-splatting/simple` (README "Verified"). **Not done:** v0.4.0 per-rig depth + joint control + no-eyes timer on the panel; real third-party sites (UMD builds, the examples browser's iframes, supersplat-viewer on the panel); frame rates recorded per page; gsplat sort artefacts from sorting around the page camera |
| 4 | **No-harm corpus** (§3.9) | **not started** | gates stage 2 only; stage 1 needs the allowlist sites signed off (row 3) |
| 5 | **Frame-rate guard** | **not started** | §3.3. Blocking for stage 2 |
| 6 | **`wovenState`** (the join signal) | **not shipped**; asked in [`layer-joined-signal.md`](layer-joined-signal.md), no browser patch exposes it | **Downgraded from blocking.** r1 made it item 1. Since v0.3.0 the timer cover plus the depth fade give clean transitions on the panel (row 3), at the price of a fixed 1.2 s to 3D. It stays wanted: it removes the per-engine read-back hook and shortens the wait. Not a gate |
| 7 | **Post-processing** | **not started** (still stands down to 2D) | **Downgraded to a coverage item.** Default-on needs *clean 2D* on such pages, which v0.4.0 already gives, with a reason. Per-eye render-target twins raise coverage later |
| 8 | **PlayCanvas `AppBase` announce hook, upstream** | **not proposed yet** | r1 wanted it before default-on. The per-instance `id` trap (§3.3) makes the current route less fragile and less costly, so it becomes **wanted, not blocking**. File it upstream in P2 anyway: it is one line on their side, and route 3 depends on a constructor detail |
| 9 | **Browser-side arbitration** (a page's `requestSession` ends the shim's session first) | wrapper in the page today (`core.js:114-127`) | wanted, not blocking. The browser has **no** one-inline-3D-session-per-document rule: the only such rule is for converted immersive-vr (`pvt:patches/0149:226-232`), and inline-3D sessions are exempt from 0150's parking (`0150:47`). So two sessions would both run and overwrite each other's rect list (woven-canvas rule 1). The page-side wrapper covers every page that goes through `navigator.xr`, which the SDK does |
| 10 | **Chip woven-safety verified on the panel** | not started | §2.2. Blocking: judged on the panel, never on a 2D monitor (§5 pitfall 1) |
| 11 | Runtime keeps display-rig factors clamped to `[0,1]` | runtime's call | §3.7 |
| 12 | **A "real panel present" fact** the browser can read (so a runtime with only a fallback display processor reads as absent) | not verified | §3.1. Small runtime ask if `XR_DXR_display_info` does not carry it |

---

## 5. Phased plan

| phase | where | work | estimate |
|---|---|---|---|
| **P0: product-harden the scripts** | displayxr-web | sentinel + lazy core split, per-instance `id` trap, `getContext`-armed PlayCanvas routes; a host config/capability interface (`decision`, `save`, `report`) with the current `localStorage` path as the fallback for the unpacked dev extension; remove hotkeys/HUD/`__dxrAuto3D` from the default build (dev flag keeps them); the chip + menu (top layer, closed shadow, placement, lifecycle, a11y); frame-rate guard; `<meta>` opt-out; Android height clamp; `dist/` + `VENDOR.json`. Harness cases: chip placement and hit-test, no layout change (computed styles and DOM of the page unchanged), meta opt-out, guard, sentinel cost | **6–8 days** |
| **P1: browser, Windows** | browser-pvt | presence state in the browser process; the `auto_3d` content-settings type + renderer push; the renderer injector (resource-bundled scripts, capability binding); `--disable-auto-3d`; address-bar icon + bubble (+ 0069 flat-region registration); Page Info row; Settings page; policy templates; `Ctrl+Shift+3` accelerator | **12–15 days**, plus one box build and a panel eyeball |
| **P2: sign-off, stage 1 release** | both + panel | allowlist sign-off per engine on the panel (row 3); chip woven-safety (row 10); allowlist compiled in; upstream PlayCanvas hook proposal | **4–6 days** of panel time |
| **P3: Android** | browser-pvt + web | the injector's Android arm and presence push (0189 events); overflow-menu item; touch chip; a pass on the Android 3D tablet | **8–10 days** |
| **P4: stage 2, default-on everywhere** | both | the no-harm corpus run + fixes; flip the default | **5–8 days**, mostly corpus fixes |
| later | both | `wovenState` browser patch → cover on the signal; per-eye post-processing twins; WebGPU adapters | separate proposals |

**Browser patches, by area (P1 + P3):**

1. **Presence:** a browser-process `DisplayXRPresence` (unknown / absent / present) fed by the
   existing support answer; a cheap static pre-check so a machine without the runtime settles on
   *absent* without waiting.
2. **Content settings:** a new `ContentSettingsType::AUTO_3D` with its registry entry, the
   per-site website setting for depth and rig, and renderer-side rules delivery.
3. **Renderer injector:** `RunScriptsAtDocumentStart` in the Chrome renderer client, reading the
   frame's rule and evaluating the two resource-bundled scripts in the main world; the per-frame
   capability binding; grd entries for the vendored `dist/` files.
4. **Switches:** `--disable-auto-3d`, `--auto-3d-dev`, `--disable-auto-3d-engines` in both
   startup arms.
5. **Desktop UI:** page-action icon + bubble, app-menu item, accelerator, Page Info row, Settings
   (site-settings category), and the 0069 flat-region hook for the bubble.
6. **Policy:** the three content-settings policies.
7. **Android UI:** overflow-menu item and Page Info row.
8. **Weave gate:** classify the new files as non-weave, so they do not turn clean rebases into
   HOLDs.

**What stays in displayxr-web:** all engine logic, the core, the chip's DOM and behaviour, the
harness, the allowlist source list, and this document. The browser owns presence, policy, storage,
the trusted UI and the injection. That is the same line r1 drew ("What stays browser-owned"),
extended to the controls.

---

## 6. Open questions for David

1. **First-release default: automatic everywhere, or automatic on an allowlist and *offer* elsewhere?**
   *Recommend the allowlist-plus-offer stage (§3.9).* Everyone still sees the chip on every
   convertible page, but an untested site is never converted without a click. Flip once the no-harm
   corpus passes.
2. **What the chip's click remembers: the site, or just this page view?** *Recommend the site
   (option A, §2.1),* with "Just this time" in the menu.
3. **Injection: the renderer injector on both platforms (more patch surface), or a component
   extension on Windows first (reuses 0134, Android later on a second mechanism)?** *Recommend the
   renderer injector:* one mechanism, and the only one that is both zero-cost and Android-capable.
4. **Pages that stay 2D (WebGPU, post-processing): say nothing, or a muted address-bar icon with the
   reason?** *Recommend the muted icon, with a setting to hide it (§2.5).* Never an in-page chip.
5. **Windows-only first release, or wait for Android?** *Recommend Windows first (P1–P2), Android as
   P3.* The chip is the first touch UI in the fork, and it deserves its own panel pass on the
   tablet.

---

## Appendix: revision 1 (2026-09-26), kept for history

The r1 text follows unchanged except for the bracketed **[r2]** notes, which say what replaced each
part.

### What it is

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

### How it ships: a component extension, like the immersive shim

**[r2: superseded by §3.2.** The immersive shim no longer ships this way by default: the Blink-native
conversion replaced it (`pvt:patches/0183`), and the component extension loads only under
`--immersive-vr-shim`. A component extension also does not exist on Android, and an always-loaded
one fails the zero-penalty requirement. Off-by-default is replaced by default-on-when-present, and
the allowlist by the staged rollout of §3.9. The source-of-truth and re-vendor rules carry over.**]**

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

**[r2: the argument for JavaScript over Blink code still holds (§3.2 keeps the adapters in JS).
What changes is how the JS is delivered: injected by the renderer, not by the extension system.
"Extension storage" is replaced by a browser content setting, because MAIN-world scripts cannot
reach `chrome.storage` without a page-forgeable relay.]**

### The dependency: `XRDisplayLayer.wovenState`

**[r2: no longer a gate for default-on, see §4 row 6. The mechanism below is still what the core
should do once the signal exists.]**

The cover in `core.js` is a still of the last mono frame (an `<img>`: a congruent `<canvas>` cover
was woven with the tile), held for a fixed **1200 ms** after the layer is created. That is the `firstWoven` hold from [woven-canvas rules](../woven-canvas-rules.md)
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

The same signal would tighten the way out. Going back to 2D, the core draws the mono frame first
and closes the layer two animation frames later, once that frame has been committed, because
`close()` reaches the browser on its own channel and could otherwise stop the weave while the last
committed frame is still the side-by-side pair (the README's "Turning off"). The two frames are an
ordering guess, like the 1.2 s hold. A close that takes effect with the next commit, or a
`wovenState` that reports `'withheld'` for the mono frame, would make it exact.

**Note (v0.4.0, from the 2026-09-27 panel run): what the covers cost without browser help.** Both
transitions are now clean on the panel, but only through three workarounds a browser-side
integration could drop or simplify (README, "Transitions"):

- The depth fades in after the go-live cover and out before a turn-off (`rampK` on the rig's ipd
  and parallax), so each swap is between two identical flat pictures. That stays worth having for
  comfort even with `wovenState`; it no longer has to hide the join.
- The 3D→2D out-cover cannot use `drawImage()` of the canvas: with an `XRDisplayLayer` bound it
  returns nothing. It is a `gl.readPixels` of the left eye, taken by each adapter in the task that
  drew it (the drawing buffer is not preserved). A readable bound canvas, or a browser-held "last
  woven frame, one eye" for the swap, would remove the per-engine hook.
- The out-cover `<img>` goes in only once decoded (`decoding = 'sync'`); inserted earlier, its box
  paints its background for a frame.

The no-eyes timeout (back to 2D when no 2-view frame arrives) now starts at the first draw on the
side-by-side store, not at the layer, so a render-on-demand page is not dropped before it has drawn.
A `wovenState` would let it start at the join instead.

### What stays browser-owned

**[r2: still holds, and is extended: presence, the per-site decision, policy and the trusted UI
are browser-owned too (§5). One correction: the browser has no one-inline-3D-session rule that
"refuses one of them" (below). Both sessions run and overwrite each other's rect list. See §4 row 9.]**

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

### What must be true before it is on by default

**[r2: replaced by §4, which keeps all four items and re-rates them against the 2026-09-26/27 panel
runs.]**

1. `wovenState` shipped, and the cover released on it (above).
2. Hardware sign-off per engine on the Windows display. For each page: stereo confirmed eye by eye,
   no raw pair at the switch (no `no-identity` token after the cover drops), comfortable depth at
   the defaults (depth per rig: camera 0.3, display 1.0, each remembered per site; one joint
   depth/parallax control on both rigs), and frame rate recorded. Every converted draw runs twice.
3. Post-processing handled, or cleanly flat. Today both engines stand down to 2D on post-processing
   chains, CameraFrame and multi-camera pages, which is a large share of modern sites. The next
   adapter step is per-eye render-target twins.
4. For PlayCanvas: detection of apps that expose no global depends on a constructor detail
   (`AppBase._applications[canvas.id] = this`). That is fine for a prototype, fragile for a
   product. The durable fix is a small upstream hook: `AppBase` announcing each app it constructs,
   the way three.js announces renderers to `__THREE_DEVTOOLS__`. It should be proposed upstream
   before auto-3D turns on by default.

### Out of scope

**[r2: unchanged.]**

WebGPU renderers (both engines), OffscreenCanvas / worker rendering, generic WebGL interception
for engines without an adapter (the browser cannot know the camera), and changes to the SDK. SDK
pages already own their session, and auto-3D stands down for them.

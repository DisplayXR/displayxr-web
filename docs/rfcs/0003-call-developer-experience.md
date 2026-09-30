# RFC 0003 — 3D calling developer experience

**Status:** draft, design only (no product code). **Tier:** `/call` stays preview until the gates in §7
pass; a new `/camera` subpath enters preview. **Author:** DX pass, 2026-09-28. **Builds on:**
[RFC 0002](0002-video-call.md) (the call module as designed and built, P0–P2a). **Touches:** the
`/call` public surface, a new `/camera` subpath, a CDN bundle, one small core helper, the hosted
signalling service, and four asks of the DisplayXR Browser. **Decisions:** see
[Decisions](#decisions-maintainer-2026-09-28) (2026-09-28).

## North star

**Any developer can drop a "holochat" call widget into ANY web app with the web SDK**, one line:
`mountCall(el, { key })` or `<dxr-call key="pk_…">`. A DisplayXR Browser user on a 3D display sees
the other people in 3D; everyone else gets a complete, fully working 2D call from the same widget.
No accounts, no backend of the developer's own, no vendor SDK. Every section below serves that goal.

## Problem

RFC 0002 answered "can a web page carry a live 3D call?" — yes, on real hardware. It did not answer
"can a web developer who has never heard of stereo add one in five minutes, ship it, and not get
paged?" Today they would meet:

- **67 exported symbols** in `call.d.ts`, of which ~45 are test helpers (`normalizeHello`,
  `mirrorSwapOps`, `createLiftPool`, …). Every one is an accidental API a page can start depending on.
- **Wall management is the page's job.** `addCall(wall, container)` needs a `createInline3D()`
  manager, and a second manager in the same document breaks both (woven-canvas rule 1). A page that
  already has a player and adds a call is one line from that bug.
- **2D→3D silently degrades under bundlers.** `mono3D: 'auto'` imports lift through a computed
  specifier with `webpackIgnore`/`@vite-ignore`, so a bundled app resolves it against the chunk URL,
  404s, and falls back to flat with a `console.info`. The feature's headline (2D callers appear in
  3D) disappears in exactly the build setup most production pages use.
- **No drop-in form.** There is no single file to paste into a CMS page, no custom element, and the
  invite UI, landing page for 2D-only recipients, and "get the browser" path are all bundled into one
  lobby that cannot be themed except through undocumented classes.
- **The hosted server is unmetered.** `wss://dxr-signal.displayxr.workers.dev` accepts any origin
  (`ALLOWED_ORIGINS = ""`), has a per-connection message limit but no per-client join limit, no
  room lifetime cap, and mints TURN credentials for anyone who asks. The TURN free tier is the only
  ceiling, and when it is hit every relayed call on every page fails at once.
- **The stereo camera is trapped inside the call.** Opening the 3D camera, its calibration, the
  mirrored self view and auto-convergence are all call internals, so "take a 3D selfie" needs the
  call module or a copy of it.

This RFC fixes the shape of the thing developers touch, and decides what belongs to the page, the
SDK, the browser, and the service.

## State (what is proven, 2026-09-28)

| Proven | Evidence |
|---|---|
| Live end-to-end 3D call on a real 3D laptop panel from its **own stereo eye-tracking camera** | Runtime extension `XR_DXR_stereo_camera` reads the pair without disturbing eye tracking (service-side rectification + online vertical refinement). The DisplayXR Browser exposes it as an ordinary `getUserMedia` device, "3D Camera (DisplayXR)", with `getSettings().displayxrStereo = {layout, rectified, baselineMm, horizontalFovDeg}` (browser work is a **draft branch**). `js/call/capture.js` already prefers it. |
| SBS over P2P WebRTC, auto-converged on the remote face | merged #92 (`call/disparity.js`, the point between the eyes, ~1 ms tracked at 5 Hz) |
| 2D callers lifted to 3D on the receiver | merged #82 (the call's lift adapter, pool, priority, budget). **The lift module itself (`js/lift/`, `./lift` export) is still on `feat/lift`, not on main**: on a main build `mono3D: 'auto'` resolves to flat. |
| Plain 2D browsers interoperate | flat both ways; a stereo sender shows its left eye |
| Hosted signalling + TURN cross-network | `dxr-signal/1` on a Worker + Durable Object; TURN minted per join, including TURN-over-TLS on 443; forced-relay run verified |

**Known gaps:** a page in an ordinary browser only ever sees 2D; the Android DisplayXR Browser cannot
enumerate cameras yet (a browser bug); the runtime's camera consent flow (R3) is not built; the
browser's capture utility borrows a panel-owner client class it should not need.

---

## 1. The one-line path

### Decision: both forms, layered — a function is the primitive, the element is sugar

```js
// ESM (npm or CDN)
import { mountCall } from '@displayxr/inline3d/call';
const call = await mountCall(document.querySelector('#call'));   // hosted signalling, auto camera, SDK UI
```

```html
<!-- a plain page, no build step -->
<script type="module" src="https://cdn.jsdelivr.net/npm/@displayxr/inline3d@1/dist/call.js"></script>
<dxr-call></dxr-call>
```

- **`mountCall(el, opts?) → Promise<CallHandle>`** is `addCall` with every argument optional: it
  finds or creates the document's wall, defaults to `dxrSignaling()`, `camera: 'auto'`, `ui: true`.
  `addCall(wall, container, opts)` stays as the explicit form, matching `addPlayer` / `addModel` /
  `addSplat`'s `(wall, target, …)` shape for pages that manage their own wall.
- **`<dxr-call>`** is a custom element that calls `mountCall(this, attrsToOpts(this))` on connect
  and `leave()` on disconnect, re-dispatching every call event as a DOM `CustomEvent`
  (`dxr-call:peer`, `dxr-call:joined`, …) and exposing the handle as `el.call`.
  Attributes are the string-typed subset of the options: `room`, `signaling` (a URL), `camera`
  (`auto|stereo|mono`), `layout`, `accent`, `max-peers`, `no-ui`, `auto-join`, `mono3d="off"`.
  Everything else (a `MediaStream`, a custom adapter, `lift`) is set as a JS property before
  connect (`el.options = {...}`) or by using `mountCall` directly.
- ~~`DisplayXR.call(el, opts)` global~~ — **dropped (Decision 11):** every target browser runs
  `type="module"`, so the CDN bundle is module-only and the SDK defines zero globals.

**Alternatives considered.** *Element only* (the embed-SDK default): loses typed options, custom
signalling and stream injection, and makes headless mode awkward. *Function only*: no paste-and-go
for CMS/no-code pages, which is the audience that most needs a zero-config path. *An `<iframe>` to a
hosted call page*: the simplest embed pattern elsewhere, but a woven canvas lives in the top-level
document's weave list and the iframe case is unverified on the browser side (open question Q2);
it also gives the host page no events.

### Embedding scope

| Host | Works? | Notes |
|---|---|---|
| Plain site / CMS page | yes | CDN bundle + `<dxr-call>` |
| SPA (React, Vue, Svelte, …) | yes | `mountCall` on mount, `leave()` on unmount; the element does this on disconnect. Route changes must not remount the widget mid-call (woven-canvas rule 2): mount it in a layout that survives navigation |
| Third-party page (a widget a developer ships to other sites) | yes | the widget uses the embedding page's document and its shared wall; the **key's origin allowlist** lists the pages it may run on |
| Cross-origin `<iframe>` | **2D: yes. 3D: open (Q2).** | the iframe needs `allow="camera; microphone"`. Inline 3D inside a cross-origin iframe is unverified on the browser side, so the widget reports `wall.supported = false` there and runs flat until the browser answers |

**What each user sees.** DisplayXR Browser on a 3D display: woven 3D tiles (stereo senders
converged, 2D senders lifted), 3D self view. Any other browser: the same widget, lobby, invite,
controls and participants, all in 2D. A stereo sender shows its left eye, and there's a
non-blocking "see it in 3D" offer (§3d). A 2D user is never a second-class participant.

**Native apps.** A native app can host the same widget in a web view, or in the project's CEF host.
Inline 3D is only available where the web view is the DisplayXR Browser/runtime path (the CEF host
over the runtime). A system web view (WKWebView, Android WebView, WebView2) gives a working 2D
call. A native call SDK (the same wire and signalling from C/C++/Kotlin/Swift) is **future work**.
The protocol freeze in §7 is what makes it possible later without a server change.

### How it gets the wall: a document-scoped shared manager (one small core addition)

Rule 1 — one inline-3D session per document — means "implicit `createInline3D()`" must not mean
"a new one". Proposed core helper, additive and semver-safe:

```js
import { sharedInline3D } from '@displayxr/inline3d';
const wall = await sharedInline3D(opts?);   // the document's live manager if one exists, else creates it
```

`createInline3D()` would register the manager it returns as the document's shared one when none
exists, so a page that made its own wall first and then adds `<dxr-call>` gets the same manager.
`mountCall` uses `opts.wall ?? await sharedInline3D()`. Session recovery (today's `recoverSession`
+ `wallOptions`) moves behind this helper, since it is a property of the document's manager, not of
the call.

*Alternative:* `mountCall` creates a private wall when `opts.wall` is absent (what `addCall`'s
callers do by hand today). Rejected: the first page that combines a call with a player tile hits
the two-manager bug and sees flat tiles with no error.

### Plain `<script>` via CDN **and** npm/bundlers

| Consumer | Loads | Lift (2D→3D) |
|---|---|---|
| CDN `<script type="module" src=".../dist/call.js">` | one pre-bundled ESM file (core + call + camera + element, ~120 KB min, no three/PlayCanvas) | `dist/lift.js` as a **lazy chunk** resolved from the bundle's own URL — we build it, so the relative import is known-good |
| CDN ESM by file (`.../js/inline3d-call.js`) | works today (~12 module requests) | relative computed import works, since every file is on the CDN |
| npm + Vite/webpack/esbuild | `@displayxr/inline3d/call` | **explicit** (below) |
| Offline / kiosk | npm, self-served | explicit |

Pinning: docs always show `@1` for the core semver range and recommend an exact version in
production; `dist/call.js` carries the version in a banner and in `CALL_SDK` (sent in `hello`).

### Lift under bundlers: explicit import, with a loud failure

The rule the SDK already applies to Draco/KTX2 decoders — no magic fetch, say what's needed —
applies here. Three mechanisms, all of which ship:

1. **Explicit injection is the documented bundler path** (it works today):
   ```js
   import { mountCall } from '@displayxr/inline3d/call';
   import { lift } from '@displayxr/inline3d/lift';
   await mountCall(el, { mono3D: lift });
   ```
2. **A peer entry point for "call with everything"**: `@displayxr/inline3d/call/full` re-exports
   `mountCall` with `mono3D` defaulted to a statically imported `lift`. A bundler sees the static
   import and code-splits it; pages that do not want the ~depth-model plumbing import `/call`.
3. **`'auto'` distinguishes "missing" from "not capable".** Today both are one `console.info`. After:
   - no WebGPU / no native provider → stays an info line + `handle.mono3D.reason` (the display
     honestly can't lift; nothing to fix);
   - **the lift module failed to import** → one `console.warn` naming the fix (the snippet above) and
     a `warning` event `{ code: 'lift-not-bundled' }`, and the lobby badge reads "2D→3D unavailable
     in this build". A developer testing in the DisplayXR Browser sees it the first time a 2D peer
     joins.

*Alternatives:* a side-effect import (`import '@displayxr/inline3d/lift/register'`) — rejected, it
conflicts with `"sideEffects": false` and is invisible in review; making lift a hard dependency of
`/call` — rejected, it drags the lift pipeline into every call bundle and lift is not on main yet.

### React: no first-party wrapper

React 19 passes properties and listens to custom events on custom elements natively, so
`<dxr-call room={room} ondxr-call:joined={...} />` works; for React 18 the docs carry a 20-line
`useCall(ref, opts)` hook recipe around `mountCall`. A package would be one more thing to version
against React majors for no capability the element lacks. Revisit if demand shows up (Q4).

### Before / after

Today's `samples/call/app.js` is 99 lines, but most of it is test harness (synthetic SBS source,
URL switches, debug hooks). The honest "before" is the minimum a developer writes today, plus what
they must know:

```js
// BEFORE — works, but: manage the wall yourself, lift is silently flat in a bundled app,
// the theming hooks are undocumented classes, and 67 exports to wade through.
import { createInline3D } from '@displayxr/inline3d';
import { addCall, dxrSignaling } from '@displayxr/inline3d/call';

const wall = await createInline3D();          // must be the ONLY one in this document
const call = await addCall(wall, document.getElementById('call'), {
  signaling: dxrSignaling(),                  // (the default, but every example spells it out)
  mono3D: 'auto',                             // flat under Vite/webpack, with an info line
});
call.on('error', (e) => console.warn(e.code, e.message));
```

```html
<!-- AFTER — a CMS page -->
<script type="module" src="https://cdn.jsdelivr.net/npm/@displayxr/inline3d@1/dist/call.js"></script>
<dxr-call accent="violet"></dxr-call>
```

```js
// AFTER — a bundled app that wants 2D→3D and its own buttons
import { mountCall } from '@displayxr/inline3d/call/full';
const call = await mountCall(document.getElementById('call'), { ui: 'tiles' });
joinBtn.onclick = () => call.join();
shareBtn.onclick = () => navigator.share({ url: call.inviteLink() });
call.on('peer', ({ id }) => roster.add(id));
```

The sample keeps its test switches but moves them into `samples/call/harness.js`; `app.js` becomes
the second snippet above.

---

## 2. Public vs internal API

### Principle

The stable surface is what a page needs to **run, observe, and dress** a call. Everything that
exists so the module can be unit-tested stays importable **by file path** from the test suite
(`js/call/*.js`) and leaves the package's `exports` map. The chrome's markup and class names are
already declared not-an-API (`sdk-stability.md`); this RFC gives theming a real API so nobody needs
them.

### Proposed surface

```ts
// @displayxr/inline3d/call
export function mountCall(el: HTMLElement, opts?: CallOptions): Promise<CallHandle>;
export function addCall(wall: Inline3D | null, el: HTMLElement, opts?: CallOptions): Promise<CallHandle>;
export function dxrSignaling(url?: string, opts?: { key?: string }): SignalingAdapter;
export const DXR_SIGNAL_DEFAULT: string;
export type { CallOptions, CallHandle, CallEvents, CallPeer, CallFormat, PeerState,
              SignalingAdapter, SignalingHooks, SignalingSession, CallTheme };

interface CallOptions {
  wall?: Inline3D;                           // default: sharedInline3D()
  room?: 'auto' | string;                    // id or invite link
  signaling?: SignalingAdapter;              // default dxrSignaling()
  key?: string;                              // publishable key for the hosted service (§5)
  iceServers?: RTCIceServer[];
  camera?: 'auto' | 'stereo' | 'mono' | string | MediaStream | StereoCamera;  // StereoCamera from /camera
  format?: CallFormat;                       // only with a raw MediaStream
  audio?: boolean;
  mono3D?: 'auto' | 'off' | LiftFunction;
  liftOptions?: Record<string, unknown>;
  autoConverge?: boolean;
  maxPeers?: number;                         // 2..4
  layout?: 'grid' | 'speaker' | 'none';      // 'none' = page lays tiles out
  ui?: boolean | 'tiles';                    // true: full chrome; 'tiles': badges/plates only; false: nothing
  autoJoin?: boolean;
  selfView?: boolean;
  theme?: CallTheme;                         // replaces `accent`
  invite?: { base?: string; updateUrl?: boolean };
  landing?: { browserUrl?: string; allow2D?: boolean };   // §3
  debug?: boolean;
}

interface CallHandle {
  readonly room: string | null;  readonly id: string;
  readonly state: 'lobby' | 'joining' | 'in-call' | 'full' | 'left';
  readonly camera: 'ok' | 'busy' | 'none' | 'pending';
  readonly localFormat: CallFormat | null;
  readonly muted: boolean;  readonly cameraOff: boolean;  readonly depth: number;
  readonly speaker: string | null;
  readonly peers: ReadonlyArray<CallPeer>;
  readonly mono3D: { on: boolean; state: 'off'|'loading'|'ready'|'unavailable'; reason: string | null; provider: string | null };
  join(): Promise<void>;  leave(): void;
  inviteLink(): string | null;
  mute(on?: boolean): boolean;  setCameraOff(on?: boolean): boolean;
  setCamera(src: string | MediaStream | StereoCamera): Promise<void>;
  retryCamera(): Promise<void>;
  setDepth(v: number): number;   setMono3D(on?: boolean): boolean;
  tile(peerId: string): HTMLElement | null;   // for layout:'none'
  on<K extends keyof CallEvents>(t: K, cb: (e: CallEvents[K]) => void): () => void;
  off<K extends keyof CallEvents>(t: K, cb: (e: CallEvents[K]) => void): void;
  diagnostics(): object;                      // explicitly UNSTABLE: convergence, lift pool, stats
}

interface CallPeer {
  readonly id: string; readonly format: CallFormat; readonly display: '3D' | '2D→3D' | '2D';
  readonly state: PeerState; readonly muted: boolean; readonly cameraOff: boolean; readonly speaking: boolean;
}

interface CallEvents {
  joined: { room: string; id: string };  left: { room: string; reason: string };
  peer: { id: string };  peerleft: { id: string; reason: string };
  state: { id: string; state: PeerState };
  display: { id: string; display: '3D' | '2D→3D' | '2D' };   // was 'format' (route/mono3d detail → diagnostics)
  speaker: { id: string | null };
  quality: { id: string; in: object | null; out: object | null };   // shape documented, values informative
  error: { code: CallErrorCode; message: string };      // fatal-for-a-feature
  warning: { code: CallWarningCode; message: string };  // new: degraded, not broken
}
```

**Headless.** `ui: false` renders no chrome at all; tiles are still module-owned (they are woven
canvases and must obey the woven-canvas rules, which is the point of the module), placed in `el`
with `data-dxr-peer="<id>"`. With `layout: 'none'` the module does not position them and
`handle.tile(id)` returns each tile's box for the page's own CSS grid. `ui: 'tiles'` keeps only the
badges and state plates — the middle ground most branded apps want (their own bar, our correct
per-tile chrome).

**Theming.** A documented set of CSS custom properties on the host — `--dxr-accent`, `--dxr-ink`,
`--dxr-shell`, `--dxr-danger`, `--dxr-radius` (chrome only, never tiles), `--dxr-font` — plus
`::part()` names on the element (`bar`, `invite`, `badge`, `plate`, `lobby`, `banner`). `theme` in JS
sets the same properties. The woven-canvas constraints (no `backdrop-filter`, no filters/opacity on a
tile or its ancestors) are enforced by the module: a `theme` or part style cannot reach a tile.

**Strings.** `theme.strings` overrides lobby/plate/banner text (a flat key→string map), which also
covers localisation. `PLATE_TEXT` stops being an export.

### Every current export and its fate

| Export | Fate | Why |
|---|---|---|
| `addCall` | **keep** (stable) | explicit-wall form |
| `dxrSignaling` | **keep** (stable), gains `{ key }` | the default transport |
| `DXR_SIGNAL_DEFAULT` | **keep** | self-hosters compare against it |
| `SignalingAdapter`, `SignalingHooks`, `SignalingSession` | **keep** (stable) | the BYO-signalling seam |
| `CallOptions`, `CallHandle`, `CallEvents`, `CallPeer`, `CallFormat`, `PeerState` | **keep, trimmed** as above | |
| `CallQuality` | keep as the documented shape of `quality` | |
| `CallAccent`, `CALL_ACCENTS` | **fold into `CallTheme`** (`theme.accent` accepts the names) | one theming API |
| `CallRoute`, `Mono3DReason` | internal → `diagnostics()`; public `display` replaces them | routes are implementation |
| `CallMono3DInfo` | trimmed into `handle.mono3D` | |
| `CallHello`, `normalizeHello`, `makeHello`, `WIRE_VERSION` | **internal**; wire spec documented in `docs/call-wire.md` | the wire is a protocol, not a JS API |
| `CallCalibration`, `rectify` option | **move to `/camera`** | calibration is a camera property |
| `CallLiftHandle`, `CallLiftFunction`, `LiftStreamPriority` | `LiftFunction` type comes from `/lift`; rest internal | one owner for lift types |
| `peerjsCloud` | **remove from the package**; lives in `samples/call/` | a demo broker DisplayXR does not run |
| `normalizeCallOptions`, `normalizeMono3D` | internal | test helpers |
| `newRoomId`, `isValidRoomId` | internal (a page gets rooms from `inviteLink()` / `room`) | |
| `parseInviteLink`, `buildInviteLink` | internal; `handle.inviteLink()` is the API | Q1: expose `parseInviteLink` for routers? |
| `roomKey`, `SIGNAL_PROTOCOL` | internal; documented in `signaling/README.md` | protocol detail |
| `routeFor`, `badgeFor` | internal | |
| `resolveLift`, `createLiftPool`, `CallLiftPool`, `createFrameWatch`, `liftConvergenceFor`, `liftPriorityFor`, `setLiftPriority`, `defaultLiftSpecifier`, `LIFT_PRIORITY` | internal | lift adapter internals |
| `convergenceShiftPx`, `lowPass`, `clampShift`, `eyeCropRect`, `measureFocusDisparity` | internal to `/call`; **`measureFocusDisparity` reappears in `/camera`** as `autoConverge` behaviour, not as a function | |
| `mirrorSwapOps`, `mirrorSwapPixels` | internal (`/camera` self view uses them) | |
| `maxBitrateKbps`, `preferVideoCodecs`, `sortCodecCapabilities`, `VIDEO_CODEC_ORDER`, `clampMaxPeers`, `MeshTransport` | internal | transport internals; an SFU adapter (RFC 0002 P3) will want a *designed* `Transport` seam, not this class |
| `qrEncode` | internal | |
| `CALL_SDK` | internal (sent in `hello`) | |
| `PLATE_TEXT` | replaced by `theme.strings` | |
| `createLiveGate` | internal | |
| handle `join`, `leave`, `inviteLink`, `mute`, `setCamera`, `setDepth`, `retryCamera`, `setMono3D`, `on`, `off` | **keep** | |
| handle `cameraOff(on)` | **rename** `setCameraOff(on)`; `cameraOff` becomes the boolean getter | read/write symmetry with `muted`/`mute` |
| handle `sendHint` | internal | P1 senders send none; auto-convergence superseded it |
| handle `format`, `wall` | `localFormat`; `wall` removed (it is `opts.wall` or the shared one) | |
| `CallPeer.hello/route/rectified/convergencePx/autoConverge/lift/quality` | → `diagnostics()` | debug data |
| options `accent` | → `theme.accent` | |
| options `calibration`, `rectify` | → `/camera` | |
| options `maxLifted` | → `liftOptions.max` | |
| options `tileAspect` | keep as `theme.tileAspect` | |
| options `inviteBase`, `updateUrl` | → `invite: { base, updateUrl }` | |
| options `browserUrl` | → `landing.browserUrl` | |
| options `recoverSession`, `wallOptions` | → `sharedInline3D()` | a property of the document's wall |
| options `scrollIntoView` | internal, always on with `ui: true` | |
| options `log` | removed; `debug: true` + `diagnostics()` | |
| events `format` | → `display` | |
| events `session` | internal | wall recovery is not the page's concern |

Mechanics: the helpers stay exported from their files under `js/call/` (tests import them there);
the `./call` entry stops re-exporting them. For **one minor release** the entry keeps the old names
as getters that `console.warn` once ("internal, will be removed from the public entry in 1.N+1");
preview-tier rules allow removal without a major, but a warning release is cheap. (Exception:
`peerjsCloud` is removed immediately — Decision 12.)

---

## 3. Browser/runtime vs page

**Rule: the browser provides capabilities through standard web APIs; the page (and the SDK in it)
owns the product.** A call is a page feature. The browser's job is to make the 3D camera, consent,
weaving and 2D→3D look like ordinary web platform pieces that any WebRTC app can use, including
ones that never heard of this SDK.

### 3a. The "3D Camera" device — browser-owned, standard shape

- **Keep** it as a normal `MediaDeviceInfo` + `getUserMedia` track, SBS frames (left eye left),
  with the non-standard `displayxrStereo` settings dictionary as the only hint. Pages detect it by
  that dictionary, **never by the label** (localisation, rebrands).
- **Ask 1:** expose the same dictionary on `InputDeviceInfo.getCapabilities()` so a page can pick
  the stereo device **without opening it**. Today `camera: 'auto'` must open a device to learn it
  is stereo, which means a camera LED blink and, on some OSes, a second permission surface.
- **Ask 2:** default the device to **rectified** output and set `rectified: true` truthfully; raw
  pairs stay available only for diagnostics. Rectification needs per-device calibration only the
  runtime has; a page cannot do it well, and the `rectify` hook in RFC 0002 becomes unnecessary for
  this device.
- Not asked: a new constraint like `{ stereo: true }`. Unknown constraints are silently ignored by
  every other browser, which makes them a trap for portable code.

### 3b. One consent flow, merged across runtime and browser

- The browser's **camera permission prompt is the consent**. The runtime must not show a second
  dialog for a browser-originated stream: the browser is a trusted runtime client that asserts
  "the user granted this origin camera access" when it opens `XR_DXR_stereo_camera`.
- The runtime owns what the browser cannot: a **system-level in-use indicator** (tray/notification)
  naming the consuming app, and a **revoke** control that ends the stream — which the page observes
  as the track's standard `ended` event (the SDK already treats that as "camera lost, retry").
- **Ask 3:** the capture path gets its **own runtime client class** (camera consumer: may read the
  stereo camera, may not own the panel) instead of borrowing a panel-owner class. This is what makes
  consent enforceable per client, and removes the risk of a camera page contending for the panel.
- Eye tracking keeps priority: consent never grants the right to disturb tracking (already true of
  the service-side reader; stated here so R3 does not regress it).

### 3c. Invite deep link

- **The shared artifact stays an `https://` link to the page that created the call**, room in the
  `#room=` fragment (never sent to a server). It opens everywhere, previews in messengers, and keeps
  the third-party origin in charge of its product.
- **`displayxr://open?url=<encoded https url>` is a launcher, not a link format.** The SDK's landing
  page (below) offers "Open in DisplayXR Browser" with it; the browser registers the scheme on
  install (Windows protocol handler, Android intent filter) and simply navigates to the embedded
  URL. Because the URL is passed whole, the fragment reaches the browser and the room still never
  touches a server. If the scheme is not registered, the button falls through (after a short
  timeout) to the download page.
- **App Links / "open with" for DisplayXR's own hosted demo origin (`call.displayxr.org`) only.** Registering the browser
  as handler for arbitrary https origins is impossible by design, and asking third parties to host
  an association file for our browser is the wrong direction.
- *Rejected:* a `displayxr://` invite as the shared link (dead in every messenger and on every
  device without the browser); `registerProtocolHandler('web+displayxr', …)` (needs a web handler
  page and only helps browsers that already visited it).

### 3d. Landing for recipients on ordinary browsers

The SDK renders it (it is page UI, and it must exist on every page that uses the module), shown when
`!wall.supported` and the page is opened from an invite:

1. **Primary: "Join now"** — joins in 2D. Never blocked, never a nag screen in front of the call.
2. **Secondary: "See the others in 3D"** — only when the platform could run the DisplayXR Browser
   (Windows, Android; macOS once it ships). Tries the `displayxr://` launcher, else links the
   release for that OS. Copy says *"on a 3D display"*: a page cannot know whether this machine has
   one, and must not pretend to.
3. After joining, a dismissible one-line banner (partial region, below the grid — today's rule).

`landing.allow2D: false` exists for 3D-only kiosk pages; `landing.browserUrl` overrides the
download link (a vendor's own distribution, a managed-fleet installer).

### 3e. A call-specific browser API? No.

Everything a call needs is standard WebRTC + `getUserMedia` + the `displayxrStereo` hint + the
inline-3D layer the SDK already uses + lift's element-level priority. A call API in the browser
would couple a product surface to browser release cadence and be usable only from the DisplayXR
Browser, whereas today a stock WebRTC app picks up a 3D camera for free. Watch-list, not asks:
background-tab capture throttling (matters for "share my 3D scene"), and autoplay policy for
remote audio (handled by the join gesture today).

**Ask 4 (bug, not design):** the Android DisplayXR Browser must enumerate cameras. Until it does,
Android callers are audio-only, which the SDK reports as `camera: 'none'`.

---

## 4. The stereo camera as its own primitive: `@displayxr/inline3d/camera`

The pieces a call uses to capture — open the best camera, know whether it is stereo and calibrated,
show a correct mirrored 3D self view, converge it on the face — are what a "3D selfie" or "record a
3D clip" page needs. They move to their own preview subpath; `/call` consumes it.

```js
import { sharedInline3D } from '@displayxr/inline3d';
import { openCamera, addCameraView } from '@displayxr/inline3d/camera';

const cam = await openCamera({ prefer: 'stereo' });   // 'auto' | 'stereo' | 'mono' | deviceId | MediaStream
cam.format;          // 'sbs' | 'mono'
cam.stereo;          // { rectified, baselineMm, horizontalFovDeg } | null   (from displayxrStereo or opts)
cam.stream;          // the MediaStream (hand it to anything: WebRTC, MediaRecorder, a canvas)

const wall = await sharedInline3D();
const view = await addCameraView(wall, canvas, cam, {
  mirror: true,          // selfie mirroring done right: mirror each half AND swap eyes
  autoConverge: true,    // face at the display plane (the call's disparity tracker)
  depth: 0,              // same [-1, 1] control as the call
});

const photo = await cam.capturePhoto({ type: 'image/jpeg' });
// → { blob, width, height, layout: 'sbs', convergencePx, suggestedName: 'photo_2x1.jpg' }
const rec = cam.record({ mimeType: 'video/webm;codecs=vp9', mono: true }); // SBS + optional left-eye copy
const clip = await rec.stop();   // → { blob, mono?: Blob, suggestedName: 'clip_2x1.webm' }  (Decision 13)

cam.on('ended', () => …);   // revoked by the runtime, unplugged, or taken by another app
cam.close();
```

Decisions:

- **`openCamera` owns device selection** (today's `camera: 'auto'` logic, the busy-device skip, the
  `displayxrStereo` preference, the >2.5:1 USB-pair heuristic for devices without the hint) and
  **calibration** (`calibration`/`rectify` move here from `/call`). A page-supplied `MediaStream`
  must declare `format`; 3D-ness is never guessed from an arbitrary stream.
- **Captured media is plain SBS with the layout in the name** (`_2x1`), so it plays in `/player`
  and anything else that understands side-by-side. Converged or raw? Photos store the **raw
  rectified pair** and report `convergencePx` alongside, so a viewer can re-converge; baking the
  shift crops the edges. (Q3: embed it as metadata.)
- **Relationship to `/call`:** `mountCall(el, { camera: cam })` accepts a `StereoCamera`; with
  `camera: 'auto'` the call calls `openCamera()` itself. The call's self view *is* an
  `addCameraView`. One implementation of capture, mirroring and convergence, one set of tests.
- **Not in `/camera`:** 2D→3D of a mono camera (that is `/lift`'s job and composes: `lift(videoEl)`),
  and any network code.

---

## 5. Hosted service productization

The hosted server should be something a developer can put in production without asking permission,
and something DisplayXR can run without a surprise bill or an outage caused by one abusive page.

### 5a. Access: anonymous tier + publishable keys

| | Anonymous (no key) | Publishable key `pk_…` |
|---|---|---|
| Who | demos, localhost, the playground, first five minutes | a page that ships |
| Origin check | none (any origin, as today) | key bound to an origin allowlist, checked on `Origin` at WebSocket upgrade |
| Signalling | yes | yes |
| TURN | yes, **short TTL (600 s)** and the first to be shed under budget pressure (§5c) | yes, 3600 s |
| Limits | tight (below) | 10× the anonymous limits, adjustable per key |
| Obtain | nothing | **issued by hand** at first (a request, then an entry in a KV namespace); self-serve later; revocable |

The key is **public** (it sits in page source). Its value is attribution + a quota bucket + an origin
binding that browsers enforce; a non-browser client can forge `Origin`, which is why quotas, not the
key, are the actual protection. No secret ever goes in a client. `dxrSignaling(url, { key })` /
`mountCall(el, { key })` / `<dxr-call key="pk_…">` pass it as a query parameter on connect.

*Alternatives:* origin allowlist only (no way to give one customer more headroom, no attribution);
a signed-token flow where the page's backend mints a join token (right for private rooms and
accounts — the `SignalingAdapter` seam already allows it — but it kills the static-page use case,
and private rooms/accounts are **out of scope for the hosted service** by decision: self-host or
bring your own adapter).

### 5b. Rate limits and caps (proposed starting values)

| Limit | Anonymous | Keyed | Where |
|---|---|---|---|
| Joins per IP per minute | 20 | 200 | Worker, Rate Limiting binding |
| Concurrent rooms per IP | 5 | 50 | per-key Durable Object counter |
| Room size | 4 (existing `MAX_PEERS`) | 4 | room DO |
| Room lifetime | 2 h, then `t:'expired'` and close | 8 h | room DO alarm |
| TURN credential mints per IP per hour | 30 | 300 | Worker |
| Messages per connection | 300 / 10 s (existing) | same | room DO |
| Message size | 64 KiB (existing) | same | room DO |

A tripped limit returns the existing `rate-limited` / `full` errors plus a new `quota` code; the SDK
surfaces them as `error` events with a human message, never a silent hang.

### 5c. TURN budget and cost ceiling

Only the ~10–20% of calls that cannot go peer-to-peer use TURN, and TURN is the only real cost.

- **Sizing.** An SBS stream at 2560×720/30 is ~3–4 Mbps. A relayed two-person 30-minute call moves
  about 2 × 3.5 Mbps × 1800 s ≈ **1.6 GB** through the relay. The free tier (1,000 GB/month) is
  therefore ~600 relayed calls/month, or ~3,000–6,000 total calls at a 10–20% relay rate. Fine for a
  preview; not a production ceiling.
- **Metering.** A scheduled Worker polls the TURN usage analytics hourly and writes month-to-date
  GB into KV; every credential mint reads it.
- **Hard cap (decided): $100/month of TURN beyond the free 1,000 GB**, org-wide, enforced by the
  service. At $0.05/GB (verify current pricing) that is roughly 2,000 GB of paid relay, so ~3,000 GB/month in all.
  Graduated shedding before the cap: at **70%** of the total, anonymous mints get TTL 300 s and a per-IP
  hourly cap of 5; at **90%**, anonymous mints stop. At **100%**, **new relays are refused for everyone**:
  `welcome` carries no TURN, and the SDK emits `error { code: 'turn-cap' }` ("relay capacity for this
  month is used up; direct connections still work") instead of a generic unreachable plate.
  **Direct P2P keeps working** throughout, and relays already allocated run until their credentials
  expire. The health endpoint reports `turn: "ok" | "degraded" | "off"`.
- Bitrate is the cheapest lever: relayed pairs could cap `maxBitrate` lower (the SDK learns from
  the selected candidate pair that it is relayed). Proposed as an SDK change in C3.

### 5d. Abuse handling

- The server relays only SDP/ICE (≤64 KiB messages, rate-limited) and TURN relays only DTLS-SRTP
  it cannot decrypt, so the realistic abuse is **resource abuse** (TURN as a free relay, join
  floods), not content. Mitigations are §5b/§5c, plus: a KV blocklist of IP prefixes and keys
  checked at upgrade; key revocation; an `abuse@` contact on the privacy page.
- Content moderation is out of scope for a P2P media service that never sees media; the privacy
  page says so and points reports of a specific page to that page's operator (its origin is known
  for keyed traffic).

### 5e. Privacy statement (what the server sees)

To publish verbatim-ish on a `/privacy` page and in `signaling/README.md`:

- **Sees:** the SHA-256 of the room id (in the connect URL), **the room id itself** (in the `join`
  message — it has to, to check the hash; it is never logged), random peer ids, the SDP and ICE
  candidates each peer sends (these contain the peers' IP addresses, codecs and DTLS fingerprints),
  the connecting IP, `Origin`, `User-Agent`, the key if any. TURN sees IPs and byte counts.
- **Never sees:** audio or video. Media is DTLS-SRTP between the browsers; relayed media is still
  encrypted end to end.
- **Honest caveat:** DTLS keys are exchanged through the signalling server, so a *malicious operator*
  of that server could man-in-the-middle a call. That is the standard WebRTC trust model; pages that
  need more can self-host signalling or (future) verify fingerprints out of band. The statement must
  not claim "end-to-end encrypted" without this sentence.
- **Retention:** room state lives in memory and is dropped when the room empties or expires; no
  database of rooms. Request logs: Worker observability off by default; when enabled for an incident,
  ≤7 days, no message bodies. Rate-limit counters are keyed by a salted IP hash and expire within
  24 h. Monthly aggregates only (joins, rooms, TURN GB) per key.

### 5f. Self-hosting

Already real and stays first-class: `signaling/worker.mjs` + `wrangler.toml` (Cloudflare, one command,
bring your own TURN key), `signaling/dev-server.mjs` (Node, zero-dep), and the protocol spec for
anyone porting it. This RFC adds: the same limits as §5b as configurable vars, a
`coturn` recipe for TURN without Cloudflare, and a documented "no TURN" mode with its expected
failure rate. **`dxr-signal/1` gets frozen at the `/call` stable gate** (§7), because self-hosters
depend on it independently of the SDK version.

### 5g. Domain migration (decided)

Signalling moves to **`wss://signal.displayxr.org`** and the demo to **`https://call.displayxr.org`**.
The `displayxr.org` zone's DNS is on Vercel; the Worker runs on Cloudflare today.

1. Add the Worker custom domain `signal.displayxr.org` on Cloudflare. It needs a CNAME in the Vercel
   DNS pointing at the Worker (or the subdomain delegated to Cloudflare); verify the certificate.
2. Add `signal.displayxr.org` to the Worker's routes in `signaling/deploy/displayxr.toml` and deploy.
   The **same Worker** answers on both hosts, so rooms are shared and a caller on the old URL meets one
   on the new.
3. Switch `DXR_SIGNAL_DEFAULT` to the new URL in the next SDK minor release.
   **`dxr-signal.displayxr.workers.dev` stays live as an alias** for at least two minor releases, and
   until its traffic (Worker analytics by host) is negligible. Only then is it retired, with a
   CHANGELOG notice first.
4. Serve the demo from `call.displayxr.org` (Vercel), and host the App Link / association files there (§3c).

---

## 6. Docs, playground, examples

| Deliverable | Content |
|---|---|
| **Hosted demo** (`call.displayxr.org`) | `<dxr-call>` with no options, the "open in DisplayXR Browser" App Link target, a keyed quota; the page everyone tests invites against |
| **Docs page** `docs/call.md` | 60-second quickstart (the two AFTER snippets), options table, events, headless recipe, theming (variables + parts, screenshot per accent), React recipe, self-hosting, privacy, what 3D needs on each side |
| **Copy-this snippet** | on the demo page and at the top of the docs, with the current pinned version filled in |
| **Troubleshooting** | table below, each row linked from the matching `error`/`warning` code |
| **Examples** | `samples/call` (reduced to the snippet), `samples/call-headless` (own layout/bar), `samples/camera` (3D selfie + clip), one bundler example (Vite) that proves lift is picked up |

Troubleshooting rows (the code is what the SDK emits):

| Symptom | Code | Cause → fix |
|---|---|---|
| A tile says "can't reach this participant" | `unreachable` | a network needs TURN: check the health endpoint's `turn`, pass a key, or bring `iceServers` |
| "Camera busy" | `camera-busy` | another app holds it (on some laptops, the eye tracker) → the call runs audio-only; "Retry camera" |
| No camera prompt / denied | `no-camera` / `permission-denied` | insecure context (`http://` on a LAN IP), or a denied permission → how to reset per browser |
| 2D callers stay 2D in my build | warning `lift-not-bundled` | import `lift` explicitly or use `/call/full` |
| 2D callers stay 2D in the DisplayXR Browser | `mono3D.reason` = `no-webgpu` / `no-provider` | the display can't lift; expected |
| Everyone flat, even stereo | — | not in the DisplayXR Browser, or a woven-canvas rule broken (link to the rules page) |
| Room full | `room-full` | 4-person mesh limit |
| Quota | `quota` | anonymous limits → get a key |
| "Relay capacity used up" | `turn-cap` | the hosted service's monthly TURN cap is reached; direct calls still work, or bring your own `iceServers` |

**Ergonomics compared with embed-style video SDKs (patterns, no products):**

- *Prebuilt iframe embed* — zero code, but the host page can't style or observe it well, and for us
  weaving needs the tiles in the page. We adopt its **zero-config default**, not its iframe.
- *Prebuilt UI component + headless core* — the common two-layer design; we match it with
  `ui: true | 'tiles' | false` over one handle, rather than two packages.
- *Room URL as the unit of sharing* — universal; ours already is, with the fragment keeping the room
  off servers, which most hosted services cannot offer because their server owns the room.
- *Server-minted join tokens* — needed for accounts/private rooms; we keep it possible through the
  adapter seam and don't make static pages pay for it.
- *CSS variables + a few named parts for theming* — the settled pattern; ours adds hard limits
  (the woven-canvas rules) that the SDK enforces instead of documenting.
- *What they don't have:* the landing flow for "the other side can't see what you see". Ours is a
  first-class part of the component (§3d) because 2D recipients are the common case.

---

## Business model (ideas, not decisions)

- **Free tier** on the hosted service: the anonymous tier plus a keyed free allowance, enough
  for prototypes and small sites.
- **Usage-based metering per publishable key.** TURN GB is the real marginal cost; signalling is ~free.
  Plan tiers are GB allowances plus rate limits. The org-wide **$100 cap** stays as the safety net
  under every plan.
- **Bring your own signalling/TURN is always free**: self-hosting (§5f) is never a paid feature.
- **Premium features:** an SFU for more than 4 participants; storage for 3D recordings and captures;
  server-side 2D→3D for non-3D senders (so 2D-only receivers' partners still get depth); branding
  removal on the widget chrome; an SLA; per-key analytics.
- **Platform/reseller model:** a usage API and webhooks per key (minutes, GB, rooms), so developers
  can pass costs through to *their* users and run their own plans on top.
- **Billing identity from day one:** every signalling session is tagged with its key id (or
  `anon`), and usage is aggregated per key now. Charging can then switch on later with no API
  change and no re-integration.
- **Not doing:** no per-call paywall or upsell inside the widget (end users never see billing), and
  no accounts for end users. Billing is between DisplayXR and the developer's key.

---

## 7. Migration and stability plan

`/call` and `/camera` promote on evidence, not on time. Each phase is independently shippable as a
minor release.

| Phase | Ships | Gate to leave the phase |
|---|---|---|
| **C0 — today** | preview `/call` (RFC 0002 P1 + P2a + auto-convergence) | — |
| **C1 — one-line path** | `mountCall`, `sharedInline3D` (core, additive), `<dxr-call>`, `dist/call.js` CDN bundle, `/call/full`, `warning` event with `lift-not-bundled`, `docs/call.md`, hosted demo page | unit tests for the element (attribute→option mapping, events, disconnect=leave); headless e2e: element in stock Chrome ↔ element in stock Chrome over the hosted server; **bundler smoke tests** (Vite + webpack + esbuild builds of the `/call/full` sample: lift resolves; plain `/call` build emits `lift-not-bundled`); one panel run: `<dxr-call>` from the CDN bundle, 3D camera → woven tile. Needs `feat/lift` merged for the lift half. |
| **C2 — surface trim + `/camera`** | the §2 table (internal helpers leave the entry, one warning release), options regrouped, `theme`/parts/strings, `/camera` preview (`openCamera`, `addCameraView`, `capturePhoto`, `record`), call built on it | `npm test` typecheck of the new `.d.ts` against a checked-in API snapshot (a diff fails CI unless the snapshot is updated in the same PR); every sample and doc snippet compiles against the public types only; panel run: 3D self view mirrored correctly (eye-swap check with the synthetic L/R pair), SBS photo opens in `/player` in 3D |
| **C3 — service** | domain migration (§5g), hand-issued keys with a key id on every session, §5b limits, TURN metering + the $100 hard cap (`turn-cap` error), `quota` error, relayed-bitrate cap, privacy page, self-host vars + coturn recipe | load test against a staging Worker (join flood trips `rate-limited`, not an outage); a forced 90% trip degrades anonymous TURN only, and a forced cap trip refuses new relays with `turn-cap` while a direct P2P call still connects; forced relay over TLS 443 still connects for a keyed page; privacy page reviewed |
| **C4 — browser/runtime** | Asks 1–4: capabilities hint, rectified default, camera-consumer client class + merged consent (R3), `displayxr://open` launcher, Android camera enumeration | runtime: consent revoke ends the track and the page sees `ended`; eye tracking unaffected with the camera open (measured, not assumed); browser: stereo device selected with no extra open; Android tablet front pair ↔ laptop call in 3D both ways |
| **C5 — stable** | `/call` and `dxr-signal/1` move into the semver-covered list; `/camera` follows when its own record allows | two consecutive releases with no change to any public option's meaning **and** the hardware matrix below green on the release candidate |

**C1 status (2026-09-28).** Implemented on `feat/call-c1` (PR): `mountCall`, `sharedInline3D`
(core), `<dxr-call>` (registered by importing `./call`), `dist/call.js` (esbuild, built by
`prepack`, ~124 KB min), `./call/full`, `warning { code: 'lift-not-bundled' }`, `key` forwarded,
`peerjsCloud` removed (Decision 12). Gate: element unit tests ✓; headless e2e ✓ — `<dxr-call>`
from the source files ↔ `<dxr-call>` from the CDN bundle in stock Chrome over the hosted server,
both in-call in ~2.1 s and seeing each other's video (VP9 1280×720) in ~4.1 s, `peerleft` on
element removal; bundler smoke ✓ — Vite 7 / webpack 5 / esbuild 0.25 × `/call/full` and `/call`
all build, and every bundled `/call` emits `lift-not-bundled` when run. **Pending:** the lift half
(`feat/lift` not merged — `js/lift/index.js` is a placeholder, so `/call/full` builds but
`liftBundled` is `false`), `docs/call.md` + the hosted demo (paired docs PR), and the panel run.

**The hardware matrix for C5** (each row a recorded run, like RFC 0002's P0 notes):

1. 3D laptop (built-in 3D camera) ↔ 3D laptop, both woven, auto-converged, 30 min without drift.
2. 3D laptop ↔ stock Chrome on a 2D laptop: 3D side sees a lifted tile; 2D side sees the left eye.
3. 3D laptop ↔ Safari on a phone (VP8 path).
4. 3D tablet (Android browser) ↔ 3D laptop.
5. Four-way mesh with mixed senders, lift budget respected, speaker priority observed.
6. Forced relay over TLS 443 on a keyed page.
7. Runtime service restart mid-call: tiles recover without a reload (RFC 0002's #172 class).
8. Camera revoked from the runtime mid-call: audio continues, plate shown, "Retry camera" works.

What stable **freezes**: the §2 surface, the event payload shapes (values in `quality` stay
informative), `hello` v1 (new optional fields only), `dxr-signal/1`, the `#room=` invite format, and
the CSS variable and part names. What it does **not** freeze: chrome markup and classes, layout
details, convergence behaviour and exact pixels, `diagnostics()`.

---

## Decisions (maintainer, 2026-09-28)

1. **`sharedInline3D()` goes into core** (additive, semver-safe) — §1.
2. **TURN spend: hard cap of $100/month beyond the free tier**, enforced by the service. At the cap,
   new relays are refused with a clear error (`turn-cap`) and direct P2P keeps working (§5c).
3. **Private rooms / accounts are not in scope for the hosted service.** Self-host or bring your
   own `SignalingAdapter` (§5a).
4. **Publishable keys are issued by hand at first**; self-serve later (§5a).
5. **Signalling and the demo move to a DisplayXR-owned domain** (`signal.displayxr.org`,
   `call.displayxr.org`). The workers.dev URL stays as an alias during the transition (§5g).
6. **North star:** a drop-in call widget for any web app (`mountCall(el, { key })` / `<dxr-call>`).
7. **`parseInviteLink` stays public** — SPA routers read the room without mounting a call.
8. **No 3D inside cross-origin iframes for now** — the widget runs in 2D there; revisit after C1.
9. **SBS photo metadata lives in the file** (XMP for JPEG, a WebM tag for recordings), so it
   travels with the photo; no sidecar.
10. **React: a docs recipe only** — no `@displayxr/inline3d-react` package until a second
    component needs the same treatment.
11. **No classic-script global** — `globalThis.DisplayXR.call` is not defined; module-only, zero
    globals.
12. **`peerjsCloud` is removed immediately** — no known external user, so no warning release.
13. **`/camera` `record({ mono: true })`** — an option (default off) that also produces a
    left-eye mono file for 2D platforms.
14. **Business model:** build key-scoped metering in C1 with **billing off**; decide on charging
    once real usage exists.

## Open questions for the maintainer

None — all resolved (see Decisions 7–14). New questions go in the PR thread.

## Not in this RFC

SFU / >4 participants and the designed `Transport` seam it needs (RFC 0002 P3); share-my-3D-scene;
screen share; recording a whole call; accounts; the lift pipeline itself (`/lift`, its own docs).

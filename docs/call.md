# 3D video calls — `@displayxr/inline3d/call`

A peer-to-peer video call widget for any web page. On the DisplayXR Browser with a 3D display,
the other people are in glasses-free 3D: a stereo camera is sent as a real side-by-side pair and
converged on the face; a plain webcam is lifted from 2D to 3D on the receiving side. In every
other browser the same widget is a complete, fully working 2D call: lobby, invite link + QR,
controls, up to four participants. No accounts, no backend of your own.

**Tier: preview.** `/call` is not yet under the 1.x semver promise
([`sdk-stability.md`](sdk-stability.md)); option names can still move between minor releases,
and the [migration plan](rfcs/0003-call-developer-experience.md#7-migration-and-stability-plan)
says which ones. This page describes the **C2** surface (1.30): the 1.29 spellings keep working
for one release with a console warning — see the [CHANGELOG](../CHANGELOG.md). Design: [RFC 0002](rfcs/0002-video-call.md) (the call itself) and
[RFC 0003](rfcs/0003-call-developer-experience.md) (this developer surface). Live demo:
[`samples/call-embed/`](../samples/call-embed/).

---

## Quickstart — three lines, no build step

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@displayxr/inline3d@1/dist/call.js"></script>
<dxr-call></dxr-call>
```

That is the whole page. The bundle registers the `<dxr-call>` custom element; the element mounts a
call in itself when it connects to the document, uses the hosted signalling server, opens the best
camera it can find, shows the lobby, and leaves the call when it is removed. Open the page in two
browsers, start a call in one, paste the invite link into the other.

`@1` follows the 1.x line. **Pin an exact version in production**
(`@displayxr/inline3d@1.x.y/dist/call.js`) so a release never moves your call under you; the
version that ships is in the bundle's banner comment and in [`CHANGELOG.md`](../CHANGELOG.md).

### npm / bundlers

```sh
npm install @displayxr/inline3d
```

```js
import { mountCall } from '@displayxr/inline3d/call';
const call = await mountCall(document.querySelector('#call'));
```

`mountCall(el, opts?)` is the primitive; `<dxr-call>` is sugar over it. With no options it does
exactly what the element does: hosted signalling, `camera: 'auto'`, full SDK chrome. It finds the
document's inline-3D session or creates one (see [How it gets the wall](#how-it-gets-the-wall)),
so it is safe to add to a page that already has a player or a splat tile.

`addCall(wall, el, opts)` — the explicit form, same shape as `addPlayer` / `addModel` — stays for
pages that manage their own `createInline3D()` session.

### `/call/full` vs `/call` + lift — which import

2D callers are lifted to 3D on a 3D display by the **lift** module (`@displayxr/inline3d/lift`).
The call does not bundle it, because most calls do not need the depth-model plumbing and a page
should not pay for it by default. Under a bundler you have to say that you want it:

| You want | Import |
|---|---|
| The call, with 2D callers lifted to 3D | `import { mountCall } from '@displayxr/inline3d/call/full';` — `mountCall` with `mono3D` pre-wired to a statically imported `lift`. The bundler sees the static import and code-splits it. |
| The call, your own lift wiring | `import { mountCall } from '@displayxr/inline3d/call'; import { lift } from '@displayxr/inline3d/lift'; await mountCall(el, { mono3D: lift });` |
| The call, 2D callers stay 2D | `import { mountCall } from '@displayxr/inline3d/call';` (and optionally `mono3D: 'off'` to skip the probe) |
| CDN, no build step | `dist/call.js` — lift is a lazy chunk next to the bundle, resolved from the bundle's own URL, so it just works |

**Why the bundler note exists.** Plain `/call` with the default `mono3D: 'auto'` imports lift
lazily through a computed specifier. Without a bundler (CDN, or ESM by file) that resolves fine.
Under Vite, webpack or esbuild it resolves against the chunk's URL, 404s, and 2D callers stay 2D.
That used to be a silent `console.info`. It now fails loudly: one `console.warn` naming the fix,
a **`warning` event `{ code: 'lift-not-bundled' }`**, and the lobby badge reads "2D→3D
unavailable in this build". You see it in the DisplayXR Browser the first time a 2D peer joins.
Fix: either row above.

A display that genuinely cannot lift (no WebGPU, no native provider) is a different case: no
warning, `handle.mono3D.reason` says why (`'no-webgpu'` / `'no-provider'`), and there is nothing
to fix.

---

## `<dxr-call>` — attributes, properties, events

Attributes are the string-typed subset of the options. Anything that is not a string (a
`MediaStream`, a custom signalling adapter, a `lift` function) is set as a JS property **before
the element connects**, or you use `mountCall` directly.

| Attribute | Option | Values |
|---|---|---|
| `room` | `room` | a room id or a full invite link. Default: the `#room=` in this page's URL, else a new room on join |
| `signaling` | `signaling` | a `wss://` URL of your own `dxr-signal/1` server. Default: the hosted server |
| `key` | `key` | a publishable key for the hosted service (`pk_…`). Reserved: keys arrive with the hosted-service phase (C3); the hosted server is anonymous until then |
| `camera` | `camera` | `auto` (default) · `stereo` · `mono` · a `deviceId` |
| `layout` | `layout` | `grid` (default) · `speaker` |
| `accent` | `theme.accent` | a named accent (`azure` `violet` `magenta` `sunset` `amber` `lime` `mint` `ice`) or any CSS colour |
| `max-peers` | `maxPeers` | 2–4, including you (default 4) |
| `no-ui` | `ui: false` | boolean attribute: no SDK chrome (see [Headless](#headless-mode)) |
| `ui="tiles"` | `ui: 'tiles'` | badges and plates only — your bar, the module's per-tile chrome |
| `auto-join` | `autoJoin` | boolean attribute: skip the lobby |
| `mono3d` | `mono3D` | `off` to keep 2D callers 2D; default `auto` |

```html
<dxr-call accent="violet" layout="speaker" max-peers="3"></dxr-call>
```

```js
// Non-string options: set before the element is connected.
const el = document.createElement('dxr-call');
el.options = { camera: myMediaStream, format: 'sbs', signaling: myAdapter, theme: { accent: 'violet' } };
document.body.append(el);

// The handle, once mounted (same object mountCall resolves to):
el.call.inviteLink();
```

**Events.** Every call event is re-dispatched on the element as a DOM `CustomEvent` named
`dxr-call:<event>` with the payload in `detail`, and bubbles:

```js
el.addEventListener('dxr-call:joined', (e) => console.log('in room', e.detail.room));
el.addEventListener('dxr-call:error',  (e) => toast(e.detail.message));
```

Disconnecting the element (`el.remove()`, a framework unmounting it) leaves the call.

---

## Options

`mountCall(el, opts)` / `addCall(wall, el, opts)`. Everything is optional.

| Option | Default | What |
|---|---|---|
| `wall` | the document's shared session | An `Inline3D` from `createInline3D()`; pass it if you manage your own |
| `room` | `'auto'` | Room id or invite link. `'auto'` = this page's `#room=` fragment, else a new one on join |
| `signaling` | `dxrSignaling()` | A `SignalingAdapter`. `dxrSignaling(url)` for your own server, or any object with `join()` |
| `key` | — | Hosted-service publishable key (reserved until C3) |
| `iceServers` | server's list | Override STUN/TURN. Default: public STUN + the TURN the signalling server hands out |
| `camera` | `'auto'` | `'auto'` opens the best camera through [`/camera`](camera.md): a stereo device when one is present (the DisplayXR Browser's "3D Camera", or a wide side-by-side device) else the default webcam; `'stereo'` prefers the pair and falls back; `'mono'` never probes; a `deviceId` string; a `MediaStream` you own; or a `StereoCamera` from `openCamera()` (left open when the call ends) |
| `format` | `'mono'` | The format of a page-supplied `MediaStream` (`'sbs'` or `'mono'`). 3D-ness is never guessed from a stream |
| `audio` | `true` | Microphone, with echo cancellation and noise suppression |
| `autoConverge` | `true` | Measure the disparity of the point between a stereo peer's eyes and put that person at the display plane. No calibration needed |
| `mono3D` | `'auto'` | Lift 2D peers to 3D: `'auto'` · `'off'` · a `lift` function (see [`/call/full`](#callfull-vs-call--lift--which-import)) |
| `liftOptions` | — | Extra `lift()` options, e.g. `{ models }` for where the depth model is served from, plus `max` (default 4): concurrent lifted tiles; further 2D peers stay flat |
| `maxPeers` | `4` | Participants including you, clamped to 2–4 (full mesh) |
| `layout` | `'grid'` | `'grid'` · `'speaker'` (the active speaker spans the row) · `'none'` (the page lays tiles out — see [Headless](#headless-mode)) |
| `ui` | `true` | `true` full chrome · `'tiles'` badges and plates only · `false` nothing |
| `autoJoin` | `ui !== true` | Join without the lobby |
| `selfView` | `true` | The small mirrored self view — an [`addCameraView`](camera.md#addcameraviewwall-canvas-cam-opts--the-self-view): a stereo self view is mirrored **and** eye-swapped, which is what a mirror does |
| `theme` | — | `{ accent, ink, shell, danger, radius, font, tileAspect, strings }` — see [Theming](#theming) |
| `invite` | — | `{ base, updateUrl }`: the link's base (default this page's URL, query kept, fragment replaced); write `#room=` into the page URL on join so a reload rejoins (default `ui === true`) |
| `landing` | — | `{ browserUrl, allow2D }`: where the "see it in 3D" offer links; `allow2D: false` for 3D-only kiosk pages |
| `debug` | `false` | Verbose console logging; `call.diagnostics()` has the rest |

Camera calibration and rectification (`calibration`, `rectify`) are [`openCamera()`](camera.md)
options now: open the camera there and pass it as `camera`. Re-opening the inline-3D session if
the runtime ends it is a property of the document's session (`sharedInline3D()`), not of the
call; a call always recovers it.

### The handle

```ts
import type { CallFormat, CallPeer, CallEvents } from '@displayxr/inline3d/call';
import type { StereoCamera } from '@displayxr/inline3d/camera';

interface CallHandle {
  readonly room: string | null;  readonly id: string;
  readonly state: 'lobby' | 'joining' | 'in-call' | 'full' | 'left';
  readonly camera: 'ok' | 'busy' | 'none' | 'pending';
  readonly localFormat: CallFormat | null;    // what YOU send: 'sbs' | 'mono'
  readonly muted: boolean;  readonly cameraOff: boolean;
  readonly depth: number;  readonly speaker: string | null;
  readonly peers: ReadonlyArray<CallPeer>;    // id, format, display, state, muted, cameraOff, speaking
  readonly mono3D: { on: boolean; state: string; reason: string | null; provider: string | null; lifted: number; max: number };
  join(): Promise<void>;  leave(): void;
  inviteLink(): string | null;                // …#room=<id>; null before a room exists
  mute(on?: boolean): boolean;  setCameraOff(on?: boolean): boolean;   // no argument toggles; returns the new state
  setCamera(src: string | MediaStream | StereoCamera, opts?: { format?: CallFormat }): Promise<{ format: CallFormat; width: number; height: number; label: string }>;
  retryCamera(): Promise<{ format: CallFormat; width: number; height: number; label: string }>;
  setDepth(v: number): number;                // the ONE depth control, [-1, 1], + = push back
  setMono3D(on?: boolean): boolean;
  tile(peerId: string): HTMLElement | null;   // for layout: 'none'
  on<K extends keyof CallEvents>(type: K, cb: (e: CallEvents[K]) => void): () => void;
  off<K extends keyof CallEvents>(type: K, cb: (e: CallEvents[K]) => void): void;
  diagnostics(): Record<string, unknown>;     // explicitly UNSTABLE: the wall, the transport, per-peer hello / route / convergence / lift / quality
}
```

`CallPeer.display` is how **this side** shows a participant — `'3D'` (a woven pair), `'2D→3D'`
(lifted), `'2D'` (flat). Everything that was debug data on the 1.29 handle and peers (`wall`,
`route`, `hello`, `convergencePx`, `autoConverge`, `lift`, `quality`) is in `diagnostics()`,
whose shape is free to change.

---

## Events

`call.on(type, cb)` returns an unsubscribe function. On `<dxr-call>` the same events are
`dxr-call:<type>` DOM events with the payload in `detail`.

| Event | Payload | When |
|---|---|---|
| `joined` | `{ room, id }` | You are in the room |
| `left` | `{ room, reason }` | You left (`'left'`: `leave()` / the element was removed; `'pagehide'`) |
| `peer` | `{ id }` | A participant appeared |
| `peerleft` | `{ id, reason }` | A participant is gone |
| `state` | `{ id, state }` | A participant's connection changed: `new` `connecting` `connected` `reconnecting` `unreachable` `left` |
| `display` | `{ id, display }` | How this side shows a participant changed: `'3D'` · `'2D→3D'` · `'2D'` (a hello arrived, lift went live, the wall came back). Route detail is in `diagnostics()` |
| `speaker` | `{ id \| null }` | The active speaker changed |
| `quality` | `{ id, in, out }` | Per peer every 2 s: resolution, fps, codec, kbps. With `id: null` and `lift`: the web lift provider is degrading the page's frame rate, or has recovered. Shape stable, values informative |
| `error` | `{ code, message, error }` | Something a feature depends on failed — see [Troubleshooting](#troubleshooting). Never fatal to the widget: a camera error joins audio-only, an unreachable peer keeps retrying. Codes are typed (`CallErrorCode`) |
| `warning` | `{ code, message }` | Degraded, not broken. Today: `lift-not-bundled` |

---

## Headless mode

`ui: false` (or `<dxr-call no-ui>`) draws no chrome: no lobby, no invite panel, no bottom bar, no
badges. You bring the buttons; the handle does the rest:

```js
import { mountCall } from '@displayxr/inline3d/call/full';

const call = await mountCall(document.getElementById('call'), { ui: false });
joinBtn.onclick  = () => call.join();
muteBtn.onclick  = () => (muteBtn.ariaPressed = String(call.mute()));
shareBtn.onclick = () => navigator.share({ url: call.inviteLink() });
depth.oninput    = () => call.setDepth(depth.valueAsNumber);
call.on('peer',     ({ id }) => roster.add(id));
call.on('peerleft', ({ id }) => roster.remove(id));
call.on('error',    ({ code, message }) => toast(`${code}: ${message}`));
```

The **tiles stay module-owned** even headless. They are woven canvases and have to obey the
[woven-canvas rules](woven-canvas-rules.md) — cover-until-joined, no effects on ancestors,
partial chrome only — and enforcing those is the point of the module. The module places them in
`el` and lays them out as `layout` says.

**`ui: 'tiles'`** is the middle ground most branded apps want: no lobby, bar, banner or invite
panel, but the badges and state plates on each tile stay (they are the module's job to get
right: partial regions, never a plate the size of the tile). **`layout: 'none'`** makes the module
create the tiles but not position them: each carries `data-dxr-peer="<id>"`, `call.tile(id)`
returns it, and your CSS lays them out on the host (the grid box steps aside with
`display: contents`). Style a tile **in place** — never move it; a DOM move is a teardown
([rule 2](woven-canvas-rules.md#2-never-remount-a-woven-canvas-inside-a-screen)).

```js
import { mountCall } from '@displayxr/inline3d/call';

const call = await mountCall(document.getElementById('call'), { ui: 'tiles', layout: 'none' });
call.on('peer', ({ id }) => call.tile(id).style.gridArea = nextArea());
```

Chrome you draw yourself has to follow the same rules as the module's. In practice: keep controls
**below or beside** the tiles, not over them; if something must sit on a tile, make it small (a
pill, never a plate the size of the tile); no `backdrop-filter` anywhere over the weave; hide
with `display: none`, never `opacity: 0`.

---

## Theming

Three hooks — and the `dxr-call-*` class names are none of them (they change without notice).

**CSS custom properties** on the host. Set them on `<dxr-call>` / the mount element or any
ancestor:

```css
dxr-call {
  --dxr-accent: #9b7bff;               /* buttons, active badge, speaking bar */
  --dxr-ink:    #fff;                  /* text on chrome */
  --dxr-shell:  rgba(16, 17, 22, .92); /* chrome background — near-solid on purpose (no blur) */
  --dxr-danger: #ff5a5f;               /* leave, muted */
  --dxr-radius: 12px;                  /* chrome corners — never a tile */
  --dxr-font:   system-ui, sans-serif; /* chrome text */
}
```

**`theme`** (the option) sets the same properties from JS, plus the tile aspect and the strings:

```js
import { mountCall } from '@displayxr/inline3d/call';

await mountCall(document.getElementById('call'), {
  theme: { accent: 'violet', radius: 8, font: 'Inter, sans-serif', tileAspect: 4 / 3, strings: { start: 'Start the call' } },
});
```

`theme.accent` (and the `accent` attribute) takes the eight named accents the player shares
(`azure` `violet` `magenta` `sunset` `amber` `lime` `mint` `ice`) or any CSS colour.

**Parts.** The chrome carries `part` names — `bar`, `invite`, `badge`, `plate`, `lobby`,
`banner`, `self`, `tile`, `grid` — and they, not the classes, are the selector contract:

```css
dxr-call [part="bar"]   { gap: 10px; }
dxr-call [part="badge"] { font-weight: 500; }
```

They are reached as attribute selectors rather than `::part()` because the chrome is **light
DOM** on purpose: a woven canvas has to live in the document's own tree, so the element has no
shadow root. If the chrome ever moves into one, the same names become `::part(bar)`.

**Strings** (`theme.strings`) override any subset of the chrome's text by key, which is also how
you localise it. Keys and defaults: lobby — `lobbyStartTitle` ("Start a 3D call"),
`lobbyJoinTitle`, `lobbyFullTitle`, `lobbyLeftTitle`, `lobbyFullText` (`{maxPeers}`),
`lobbyText` (`{camera}`, `{kind}`), `cameraDefault`, `kindBusy`, `kindNone`, `kindSbs` /
`kindMono` (`{width}`, `{height}`), `liftOff`, `liftChecking`, `liftMissing`, `liftNoProvider`,
`liftNative` (`{provider}`), `liftWeb`, `liftProven`, `liftUnproven`, `start`, `join`, `rejoin`,
`retryCamera`, `cameraSelect`, `joining`; invite — `waitingTitle`, `waitingText`, `inviteTitle`,
`inviteText`, `inviteLink`, `copyLink`, `copied`, `pressCopy`, `qrLabel`; banner — `banner2D`,
`bannerLink`; bar — `mute`, `unmute`, `cameraOn`, `cameraOff`, `cameraRetry`, `cameraBusyRetry`
(`{cameraBusy}`), `depth`, `invite`, `leave`; tiles — `connecting`, `reconnecting`, `leftCall`,
`cameraOffPlate`, `noCamera`, `unreachable`, `cameraBusy`, `you`, `badge3D`, `badge2D3D`,
`badge2D`, `badgePending`. `{…}` placeholders are filled by the module.

**What theming cannot reach, by design.** A woven tile and every ancestor of it must be visually
bare: no `filter`, `opacity < 1`, `border-radius`, `box-shadow`, `mask`, `backdrop-filter`
([rule 7](woven-canvas-rules.md#7-no-css-effects-on-a-woven-canvas-or-on-any-of-its-ancestors)).
The chrome's own translucent surfaces use a near-solid tint instead of a blur for the same reason
([rule 10](woven-canvas-rules.md#10-no-backdrop-filter-on-anything-drawn-over-the-weave)). The
variables and parts above only ever style chrome (`--dxr-radius` is never applied to a tile), so
a theme cannot break a tile — that constraint is enforced by the module, not documented at you.

---

## What each user sees

| | DisplayXR Browser on a 3D display | Any other browser |
|---|---|---|
| Stereo senders | woven 3D, converged on the face | their left eye, flat |
| 2D (webcam) senders | lifted to 3D (with lift; badge `2D→3D`) | flat |
| Self view | 3D, mirrored and eye-swapped | mirrored 2D |
| Lobby, invite link + QR, controls, badges | yes | yes, identical |
| Who can join | anyone | anyone |

A 2D user is never a second-class participant. When the page is opened from an invite in a
browser without inline 3D, the widget shows **"Join now"** first (2D, never blocked) and, on a
platform that could run the DisplayXR Browser, a secondary "see the others in 3D on a 3D display"
offer; after joining, a dismissible one-line banner below the grid. `landing.browserUrl` points
that offer at your own distribution if you have one; `landing.allow2D: false` is for 3D-only
kiosk pages.

**What 3D needs on each side.** To *send* 3D: a stereo camera — the DisplayXR Browser's built-in
"3D Camera" device on a 3D laptop, or a side-by-side USB pair (a device delivering wider than
2.5:1 frames is treated as one). To *see* 3D: the DisplayXR Browser on a 3D display. Neither is
needed to take part.

---

## Embedding scope

| Host | Works? | Notes |
|---|---|---|
| Plain site / CMS page | yes | CDN bundle + `<dxr-call>` |
| SPA (React, Vue, Svelte, …) | yes | `mountCall` on mount, `leave()` on unmount — the element does both itself. **Do not remount the widget mid-call** on a route change ([rule 2](woven-canvas-rules.md#2-never-remount-a-woven-canvas-inside-a-screen)): mount it in a layout that survives navigation |
| Third-party page (a widget you ship to other people's sites) | yes | the widget uses the embedding page's document and its shared inline-3D session |
| Native app | 2D: yes. 3D: where the web view is the DisplayXR path | a system web view (WKWebView, Android WebView, WebView2) gives a working 2D call; inline 3D needs the DisplayXR Browser/runtime path |
| Cross-origin `<iframe>` | **2D only** | needs `allow="camera; microphone"` on the frame. A woven canvas lives in the top-level document's weave list; 3D inside a cross-origin iframe is not verified on the browser side, so the widget reports no inline 3D there and runs flat. Same-origin iframes and the plain page are the 3D path |

### How it gets the wall

[Rule 1](woven-canvas-rules.md#1-one-inline-3d-session-per-document): one inline-3D session per
document — two live sessions overwrite each other's rect list every frame and every tile goes
flat with no error. So `mountCall` never creates a private session. It uses
`opts.wall ?? await sharedInline3D()`, a core helper that returns the document's live session or
creates it; `createInline3D()` registers the session it returns as the shared one when none
exists. A page that made its own wall first and then adds `<dxr-call>` gets the same session.

```js
import { sharedInline3D } from '@displayxr/inline3d';
const wall = await sharedInline3D();   // the same object mountCall will use
```

---

## Invite links

The shared artifact is an ordinary `https://` link to the page that created the call, with the
room in the **`#room=` fragment**. Browsers never send a fragment to a server, so the room id
never appears in a URL log — not the page's, not the signalling server's (which addresses rooms
by a SHA-256 of the id). The link opens everywhere, previews in messengers, and keeps *your*
origin in charge of the product.

- `call.inviteLink()` — the link for the current room (`null` before one exists).
- `room: 'auto'` (default) picks up `#room=` from the page's own URL, so a recipient who opens the
  link lands in the room; `updateUrl` writes it on join so a reload rejoins.
- `invite.base` sets the link's base when the page that mounts the widget is not the page a
  recipient should open (a modal, a route with private query parameters); `invite.updateUrl`
  controls the `#room=` write-back.
- `parseInviteLink(linkOrLocation) → room | null` is public so an SPA router can read the room
  and route to the call screen **without** mounting a call first.

Room ids are ≥ 96 random bits (generated ones: 128), base64url. Anyone with the link can join
until the room is full; there are no private rooms on the hosted service — bring your own
adapter for that (below).

---

## Self-hosting signalling and TURN

The hosted server (`DXR_SIGNAL_DEFAULT`, `wss://dxr-signal.displayxr.workers.dev` today, moving
to `wss://signal.displayxr.org`) is what the widget uses with no `signaling` given. It relays
offers/answers/ICE and mints short-lived TURN credentials; it is fine for demos, prototypes and
small sites. Self-hosting is first-class and always free:

```js
mountCall(el, { signaling: dxrSignaling('wss://signal.example.com') });
```
```html
<dxr-call signaling="wss://signal.example.com"></dxr-call>
```

[`signaling/README.md`](../signaling/README.md) has the protocol (`dxr-signal/1`, JSON over
WebSocket), a Cloudflare Worker + Durable Object reference server (`signaling/worker.mjs`,
`wrangler.toml`, one command to deploy, TURN credentials via `TURN_KEY_ID` /
`TURN_KEY_API_TOKEN` / `TURN_TTL`), and a zero-dependency Node server for local work
(`node signaling/dev-server.mjs` → `ws://localhost:8787`).

- **TURN.** About 10–20 % of networks cannot connect peer-to-peer and need a relay. Without TURN
  those calls show a participant as `unreachable`. Configure it on your server, or pass your own
  `iceServers` to the widget (they override the server's list).
- **Your own accounts / private rooms.** The `SignalingAdapter` seam is any object with
  `join(room, hooks) → Promise<SignalingSession>` (`call.d.ts`): a backend that mints join tokens,
  a push service, an existing WebSocket. The call only needs a way to exchange opaque blobs
  between peers.
- `getUserMedia` needs a secure context: `localhost` counts, a LAN IP over plain `http` does not.

---

## React recipe

There is no `@displayxr/inline3d-react` package on purpose: the element already carries every
capability, and a wrapper would be one more thing to version against React majors.

**React 19** sets properties and listens to custom events on custom elements natively:

```jsx
import '@displayxr/inline3d/call';   // registers <dxr-call>

export function Call({ room }) {
  return (
    <dxr-call
      room={room}
      accent="violet"
      ondxr-call:joined={(e) => console.log('joined', e.detail.room)}
      ondxr-call:error={(e) => toast(e.detail.message)}
    />
  );
}
```

**React 18** (and any framework with a ref): a small hook around `mountCall`. The ref target
must not be re-created by a re-render — keep it in a component that survives navigation
([rule 2](woven-canvas-rules.md#2-never-remount-a-woven-canvas-inside-a-screen)), and remember
Strict Mode mounts twice in development.

```jsx
import { useEffect, useRef, useState } from 'react';
import { mountCall } from '@displayxr/inline3d/call/full';

export function useCall(opts) {
  const ref = useRef(null);
  const [call, setCall] = useState(null);
  useEffect(() => {
    let handle, cancelled = false;
    mountCall(ref.current, opts).then((h) => {
      if (cancelled) { h.leave(); return; }
      handle = h; setCall(h);
    });
    return () => { cancelled = true; handle?.leave(); setCall(null); };
  }, []);                                   // mount once; options are read at mount
  return [ref, call];
}

export function Call() {
  const [ref, call] = useCall({ ui: 'tiles' });
  return (
    <>
      <div ref={ref} />
      <button onClick={() => call?.join()} disabled={!call}>Join</button>
    </>
  );
}
```

---

## Troubleshooting

Each row is what the widget emits (`error` / `warning` events, `handle.camera`,
`handle.mono3D.reason`), the cause, and the fix.

| Symptom | Code | Cause → fix |
|---|---|---|
| A tile says "Can't reach this participant" | `error` `unreachable` (`error.peer` = the tile) | That pair has had no connection for ~10 s: one side is on a network that needs a relay (TURN). Retries continue in the background and the plate clears on its own if it connects. Fix: TURN on your signalling server, or your own `iceServers`; on the hosted server, check its health endpoint's `turn` |
| "Camera busy" plate on your self view; `handle.camera === 'busy'` | `error` `camera-busy` | Every camera is held by another process. **On 3D laptops that is usually the eye tracker**, which owns the camera while tracking; the call joins audio-only. Fix: the "Retry camera" button / `call.retryCamera()` once it is free, or `camera: <deviceId>` for a different device. The DisplayXR Browser's built-in "3D Camera" device reads the pair *without* taking it from tracking, so prefer it where present (`camera: 'auto'` does) |
| No camera prompt, or denied | `error` `permission-denied` / `no-camera` | `permission-denied`: the prompt was refused, a policy forbids it, or the context is insecure (`http://` on a LAN IP). `no-camera`: no device. Fix: serve over `https://` or `localhost`; reset the site's camera permission in the browser's site settings (the lock icon in the address bar) and reload |
| Cannot reach the signalling server | `error` `signaling-unreachable` | The URL is wrong, the server is down, or a proxy blocks WebSockets. Check `signaling`; for self-hosted, that `wss://` (not `ws://`) is used from an `https://` page |
| Tiles went flat mid-call in the DisplayXR Browser, then came back | `error` `session-ended` | The inline-3D session ended without the page closing it (a runtime service restart). The widget re-opens it and re-weaves the tiles by itself; media is not interrupted. Nothing to do unless it does not come back, in which case reload |
| 2D callers stay 2D **in my bundled build** | `warning` `lift-not-bundled` | The lift module could not be imported from the bundle. Fix: `import { mountCall } from '@displayxr/inline3d/call/full'`, or import `lift` yourself and pass `mono3D: lift` ([above](#callfull-vs-call--lift--which-import)) |
| 2D callers stay 2D in the DisplayXR Browser, no warning | `handle.mono3D.reason` = `no-webgpu` / `no-provider` | This display can't lift; expected. `mono3D.state` says `unavailable` |
| Everyone flat, even a stereo sender, in the DisplayXR Browser | — | Either the page is not on the inline-3D path (`inline3DAvailable()` is false: a cross-origin iframe, a system web view), or a [woven-canvas rule](woven-canvas-rules.md) is broken — most often an effect (`border-radius`, `opacity`, `filter`, `backdrop-filter`) on the mount element or one of its ancestors, or a second `createInline3D()` in the document. The browser's `withheld` log line says which |
| "This call is full" | `error` `room-full` | Four is the mesh limit (`maxPeers` can only lower it). More participants is RFC 0002 P3 (an SFU) |
| Quota / rate limit on the hosted server | `error` `quota` (C3), `rate-limited` | The anonymous tier's limits. Self-host, or get a key when keys ship |
| "Relay capacity used up" | `error` `turn-cap` (C3) | The hosted service's monthly TURN cap. Direct calls still connect; bring your own `iceServers` for relayed ones |

---

## Privacy — what the server sees

The signalling server sees the SHA-256 of the room id (in the connect URL), the room id itself
(inside the `join` message, so it can check the hash; never logged), random peer ids, the SDP and
ICE candidates each peer sends (which contain the peers' IP addresses, codecs and DTLS
fingerprints), the connecting IP, `Origin`, `User-Agent` and the key if any; a TURN relay sees
IPs and byte counts. It **never sees audio or video**: media is DTLS-SRTP between the browsers,
and relayed media is still encrypted end to end. One honest caveat: DTLS keys are exchanged
through the signalling server, so a *malicious operator* of that server could man-in-the-middle a
call — the standard WebRTC trust model. Pages that need more than that self-host signalling
(above). Room state lives in memory and is dropped when a room empties; there is no database of
rooms.

---

## Read next

- [`samples/call-embed/`](../samples/call-embed/) — the copy-this-snippet demo; [`samples/call/`](../samples/call/) — the explicit `addCall` form with test switches (synthetic stereo pair, local dev server); [`samples/camera/`](../samples/camera/) — the 3D selfie page.
- [`camera.md`](camera.md) — the camera primitive the call is built on: `openCamera`, the mirrored self view, `capturePhoto` / `record`.
- [`woven-canvas-rules.md`](woven-canvas-rules.md) — what a page hosting a woven tile must and must not do.
- [`authoring-inline-3d.md`](authoring-inline-3d.md) — the inline-3D model under the widget.
- [`signaling/README.md`](../signaling/README.md) — protocol, reference servers, TURN.
- [RFC 0003](rfcs/0003-call-developer-experience.md) — the full surface, the phases (C1–C5) and what is frozen when `/call` goes stable.

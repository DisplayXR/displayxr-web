# RFC 0002 — a 3D video-call module

**Status:** draft; P0 done, P1 implemented (`feat/call-p1`, see §7). **Tier:** preview (like `/splat`, `/model`, `/player` — see
`docs/sdk-stability.md`). **Author:** architecture pass, 2026-09-25. **Touches:** new
`@displayxr/inline3d/call` subpath, a small open-source signalling server, one DisplayXR Browser
patch (Android stereo camera). No change to core.

## Problem

A page can weave a photo, a movie, a glTF or a splat, but not a person. Video calling is the most
obvious "3D of a real human" use of a glasses-free display, and today every attempt at it has been a
native, vendor-locked app. This RFC scopes `@displayxr/inline3d/call`: drop a call into any page, share
an invite link, and every participant with a 3D display sees the others in 3D — with any camera, on
any browser, peer-to-peer, at no service cost.

It is a **DisplayXR feature, not a vendor one**: no vendor account, no vendor SDK, no vendor server in
the default path. Vendor technology (e.g. a vendor's 2D→3D module) plugs in through the runtime's
provider mechanism (§5), never through this module.

## Prior art (what we keep, what we don't)

Four generations of 3D calling exist in private vendor repos (2015–2026). Findings that shape this
design:

| Lesson | Evidence |
|---|---|
| **Side-by-side (SBS) on a stock codec works in production.** Full-width L\|R, 2×1280×720 on tablets, 2×1280×1440 on phones, 30 fps. | The shipped mobile app; its Windows demo |
| **The 3D flag lives out of band**, never in the codec/SDP/RTP. Every working system tagged each participant as SBS or MONO in its signalling (display-name suffix, external user id). | All four generations; a forked WebRTC tree changed nothing in WebRTC itself |
| **The receiver decides how to show a mono sender:** lift to 3D on a 3D display, flat on a 2D one. A 2D receiver shows the left eye. | Mobile app; the newest Windows client lifts every tile on the receiver |
| **Colour+depth and 4-view packings were tried and abandoned.** Codec compression smears depth edges; 4-view costs resolution for little gain. | 2020 prototypes |
| **Rectify on the sender**, per device. **Never mirror the wire.** | Mobile app shaders; see the mirroring trap in §4 |
| Reconvergence for a parallel stereo camera ≈ `f_px · baseline / (2 · subjectZ)`, low-pass smoothed (α≈0.2). | Windows client, Android renderer |
| Lowering a stream tier halves **per-eye** width. Drop frame rate before resolution. | Windows demo: SBS subscription tiers |
| **Avoid:** vendor-SDK lock-in (Zoom, Agora, Chime), secrets in the client, software YUV on the render path, guessing 3D-ness from the aspect ratio. | All of the above |

## 1. API shape

```js
import { createInline3D } from '@displayxr/inline3d';
import { addCall, dxrSignaling } from '@displayxr/inline3d/call';

const wall = await createInline3D();
const call = await addCall(wall, container, {
  room: 'auto',                       // or a code taken from an invite link
  signaling: dxrSignaling(),          // default hosted server | dxrSignaling(url) | custom({...})
  iceServers: undefined,              // default: public STUN + DisplayXR's TURN; page may override
  camera: 'auto',                     // 'stereo' | 'mono' | a MediaStream the page supplies
  mono3D: 'auto',                     // lift mono peers via lift(): 'auto' | 'off'
  maxPeers: 4, layout: 'grid',        // | 'speaker'
  ui: true,                           // SDK chrome (lobby, invite, bar); false = headless
});
call.inviteLink();                    // https://…#room=… (also a QR code in the SDK UI)
call.mute(on); call.setCamera(id|stream); call.setDepth(v); call.leave();
call.on('peer' | 'peerleft' | 'format' | 'quality' | 'speaker' | 'error', cb);
```

`addCall(wall, container, opts) → CallHandle`. **Container, not canvas**: unlike the other modules, a
call owns a *variable* number of tiles, so it creates and owns the per-participant canvases inside
`container` (§3). `wall` may be unsupported: the call still works, all tiles flat (§6).

## 2. Transport and signalling

- **WebRTC peer-to-peer, full mesh, ≤4 participants** behind a `Transport` interface. Media is
  DTLS-SRTP end-to-end; signalling sees a room id and SDP only. Mesh upload at 2560×720/30 is
  ~3–4 Mbps per peer (≈10 Mbps for four) — fine on Wi-Fi, marginal on cellular. **>4** later via an
  SFU adapter (LiveKit, Apache-2.0, self-hostable); the module API does not change.
- **Signalling = pluggable `SignalingAdapter`.** Default `dxrSignaling()`: a tiny open-source server
  (Cloudflare Worker + Durable Object per room) run by DisplayXR at ~$0 at our scale; anyone can host
  their own (`dxrSignaling(url)`), or plug in their own accounts/push (`custom()`). PeerJS cloud is
  a P0 convenience only (no uptime guarantee, not ours).
- **TURN:** ~10–20% of networks need a relay. Default DisplayXR-provided (Cloudflare TURN free tier,
  short-lived credentials minted by the signalling server — **no secret ever in the client**);
  `iceServers` overrides.
- **Codec:** VP9 preferred, VP8 fallback, AV1 opportunistic. **The DisplayXR Browser has no H.264**
  (proprietary-codec build), so H.264 is never required. Sender: `contentHint='detail'`,
  `degradationPreference='maintain-resolution'`, `maxBitrate` per tier.

### Wire format

- **Video:** `sbs` = full-width L\|R (left eye left), at whatever per-eye width the camera
  delivers (a real raw stereo camera is 640 per eye; ≥960 is a preference, not a requirement, and
  nothing is upscaled); or `mono`. No depth or 4-view on the wire.
- **Data channel, reliable, per peer:**
  - `hello` on open: `{v, format:'sbs'|'mono', width, height, baselineMm?, hfovDeg?, rectified,
    sdk}` — the out-of-band 3D flag.
  - `hint` ≤5 Hz: `{subjectZmm}` (face distance from the camera, from face disparity or size) —
    drives the receiver's convergence.
  - `state`: mute / camera-off / speaking.
- A peer that sends no `hello` (a foreign client) is treated as `mono`.

## 3. Rendering

**One `<video srcObject>` + one woven canvas per remote participant** (a `wall.addVideo` or
`lift()` window), laid out by the module in `container`. Not one composed canvas: native lift works
per element (the runtime's `XR_DXR_lift` has no sub-rect regions — §5), and per-tile windows keep the
existing lazy-layer machinery. Tiles are persistent while a peer is present — no crossfading woven
canvases (`docs/woven-canvas-rules.md`, rule 6).

| Remote sends | Local display 3D | Local display 2D |
|---|---|---|
| `sbs` | woven SBS + **convergence shift** (below) | left eye, flat |
| `mono` | `lift(video, {providers:{video:'auto'}})` | flat |

- **Convergence (SBS):** a horizontal per-eye crop offset of `f_px · baseline / (2 · subjectZ)` from
  `hello` + `hint`, low-pass α≈0.2, so the remote face sits at the display plane. Tracking-loss easing
  reuses the player's `_trackBakedStereo`.
- **One depth control for every tile:** the SBS crop offset, or `lift` convergence for lifted tiles.
- **Self view:** small, 3D when the local camera is stereo. **Mirroring trap:** mirroring an SBS frame
  also swaps the eyes — mirror each half AND swap halves. The wire is never mirrored.

## 4. Capture (`CaptureSource`)

| Source | How | Status |
|---|---|---|
| USB stereo camera exposing one SBS device | aspect > 2.5 (label as a probe-order hint) | **P1.** Field data (2026-09-25): a vendor's stereo camera enumerates as ONE device, 1280x480 @30 = 640x480 per eye, a real L\|R pair — but **grayscale and unrectified** (visible vertical misalignment). Sent raw with `rectified: false`; receivers apply only the convergence shift |
| Rectification of a raw pair | needs the camera's calibration (intrinsics/extrinsics keyed by the ACTIVE device's serial), from a plug-in-provided `MediaStream` or rectify-in-JS fed by the runtime | **P2.** P1 ships the seam: `addCall({ rectify })` → a rectified stream, and the hello then says `rectified: true` |
| 3D tablet front stereo pair (Android DXR Browser) | **browser patch** exposing it as ONE rectified SBS `MediaStream` + calibration (baseline, intrinsics) | approved; after P0 |
| Any mono webcam | `getUserMedia` | works today |
| Laptop eye-tracking cameras | **not available on every laptop class** — on some it is held exclusively by the eye tracker (`NotReadableError: Device in use`, P0 and field data 2026-09-25); on others the same kind of camera enumerates as a stereo device (row 1). `camera: 'auto'` skips a busy device silently; such laptops are **mono senders** (their HD webcam), lifted on the receiver | skipped gracefully (P1) |

## 5. Mono→3D: the provider chain, not this module

Mono peers go through `lift()` (`@displayxr/inline3d/lift`), which picks a provider:

1. **Native vendor module** when the runtime reports one — `XR_DXR_lift`, running in the DisplayXR
   service next to the display processor (e.g. a vendor's 2D→3D engine via its plug-in). Supersedes
   the open default. Streams are per-element; ~14–22 ms per convert, serialised, so four mono tiles
   ≈ 11–16 Hz each. **Per-stream priority** (`xrSetLiftStreamPriorityDXR`: HIGH / NORMAL / LOW /
   PAUSED) lets the call lift the **active speaker every round** and background tiles less often.
2. **Open web fallback** — Video-Depth-Anything-Small on ONNX Runtime WebGPU.
3. **Flat.**

`liftCapabilities()` → `{native, provider, maxStreams, approxMsPerConvert, modes, webFallback}` lets
the lobby badge each participant **3D / 2D→3D / 2D** before the call starts. This module never
contains vendor code or depth models.

## 6. UX

1. **Start:** "Start 3D call" → camera + mic permission → **3D self-preview** (check depth/framing) →
   room created.
2. **Invite:** copy link, QR code (a tablet scanning a laptop screen), or short code. Anonymous — no
   accounts in v1.
3. **Join:** open link → preview → join. Lobby lists who is in with a **3D / 2D→3D / 2D** badge.
4. **In call:** grid ≤4 or speaker layout; self-view; depth slider; mute / camera / leave in a bottom
   bar that obeys the woven-chrome rules (partial region, near-solid translucent, no
   `backdrop-filter`, never covering a whole tile).
5. **Plain browsers are first-class:** a DisplayXR user can call anyone on stock Chrome/Safari/Firefox;
   that side is an ordinary 2D call (VP8 for Safari) with a "View in 3D with DisplayXR Browser"
   banner.

## 7. Phases

- **P0 — validate** (`samples/call-p0/`, throwaway): camera enumeration on real devices; SBS 2560×720
  over WebRTC + `addVideo` weave in the DisplayXR Browser. Verified 2026-09-25: headless loopback 2560×720 VP9 30 fps both ways; **DisplayXR Browser 154.0.8037.17 on
  an SR panel**: `hello` exchanged, `route: woven-sbs`, inbound 2560×720 VP9 30 fps, 0 dropped, no quality
  limitation, and the synthetic pair seen popping out of the panel. The SR laptop's tracking camera is
  exclusive to the eye tracker. A `canvas.captureStream()` sender throttles to ~1 fps when its window is
  occluded (matters for share-my-3D-scene, not for camera senders). **Cross-box (mac headless Chrome →
  win DXR Browser, WAN):** 2560×720 VP9 30 fps, woven layer 16:9 after a sample CSS fix (never
  `object-fit` a woven canvas). **Open:** that run showed ONE eye on the panel although the received
  frame carried a correct pair and the browser logged `ID-MATCH FALLBACK` (stamped layer, no quad) —
  **Round 2 (8K panel, DPR 3, weave-dump oracle):** sample and scroll CLEARED — scrollY 0 / 300 and
  the old in-DOM-video build all feed the weaver one correct L|R pair (exact 900 dev-px shift, no
  ID-MATCH FALLBACK). Prime suspect is the browser's **post-reconnect** state: after a weave-session
  loss (`xrWeaveSubmitDXR` -17 instance-lost → recovery → reconnected, e.g. a service restart) the
  weave input carried the whole SBS frame in EACH eye half until a page reload — seen ONCE (the
  browser's very first weave submit lost), NOT reproduced in 6 deliberate restarts incl. the exact
  first-weave race; live reconnects are fine and the square floats on the real SR panel. **Reliable
  repro = browser cold-started while the service is down** (pre-sandbox weave init misses → tile fed
  L|R|L|R, flat until reload): filed as displayxr-browser-pvt#172. Product requirement
  regardless: a call outlives service restarts, so the module must survive a layer/session loss
  without a reload. Also pending: eye tracking while the
  webcam is open, a real stereo camera, tablets. Product note: a peer that leaves must surface a
  "peer gone" state and auto-redial — the probe's tile just went black.
- **P1 — preview module** (`feat/call-p1`, `js/inline3d-call.js` + `js/call/`, `signaling/`,
  `samples/call/`, `test/call.test.mjs`):
  - [x] mesh ≤4 behind a `Transport` seam; `maxPeers` enforced by client and server; VP9 > VP8 > AV1
    (`setCodecPreferences`, SDP munge fallback); `contentHint='detail'`,
    `maintain-resolution`, `maxBitrate` per mesh size; audio with EC/NS and mute
  - [x] `SignalingAdapter`; `dxrSignaling(url)` + the `dxr-signal/1` protocol
    (`signaling/README.md`); Cloudflare Worker + Durable Object template with server-minted TURN
    credentials (not deployed); zero-dep Node dev server; `peerjsCloud()` demo adapter
  - [x] invite links: 128-bit room ids in the `#room=` fragment; only a SHA-256 of the room is in
    any URL the signalling server sees
  - [x] SBS from USB stereo cams (`camera:'auto'`, aspect > 2.5, busy devices skipped), raw with
    `rectified:false` + a `rectify` hook for P2
  - [x] convergence from `hello`/`hint` (α 0.2, clamped ±12% of the eye width) + depth slider;
    `hint` is accepted (≤5 Hz) but P1 senders send none, so it is 0 unless a page calls
    `sendHint()`
  - [x] mono flat (`mono3D` hook in place, resolves to flat), 2D-receiver fallback (left eye)
  - [x] layer/session loss: a failed layer is retried with backoff; an ended session is re-opened
    and every tile re-registered, no reload
  - [x] peer lifecycle: Connecting / Reconnecting / Left-the-call plates, ICE restart → rebuild
    with backoff, rejoin via the link
  - [x] SDK chrome (lobby, 3D self-preview, invite link + QR, bar, badges, banner, grid/speaker),
    sample, tests
  - **Deviations:** (1) the woven SBS tile is `wall.addImage(tile, convCanvas)` over a
    module-painted intermediate canvas, not `addVideo` — `addVideo` draws the whole frame and the
    core's paint refuses a non-`<video>` source there; `addImage` documents a page-owned canvas as
    a source, so the core still owns the woven buffer and no core change was needed. (2)
    `dxrSignaling()` defaults to the hosted server `wss://dxr-signal.displayxr.workers.dev` (Cloudflare Worker + Durable Object, Cloudflare Realtime TURN minted per join, incl. TURN-over-TLS on 443; deployed 2026-09-26). (3)
    No `custom()` helper: any object with `join()` is an adapter. (4) The self view sits in a
    footer below the grid rather than over it, so no chrome ever covers a woven tile. (5) Extra
    handle surface beyond §1: `join()`, `cameraOff()`, `sendHint()`, events `state`, `joined`,
    `left`, `session`. (6) P1 lobby badges are per-tile after joining (3D/2D); the pre-join
    3D / 2D→3D / 2D list needs `liftCapabilities()` (P2).
- **P2 — lift + tablets:** mono peers via `lift()` + priority; Android stereo-camera browser patch.
- **P3 — scale + extras:** SFU adapter, share-my-3D-scene (`canvas.captureStream`), face-centred crop.

## Open questions

- P0 results decide §4 (how stereo cameras enumerate) and whether `maintain-resolution` holds
  2560×720 under real congestion.
- Where the signalling Worker lives (repo, domain) and TURN credential lifetime.
- Whether the Android stereo patch should also expose per-frame calibration or only static.

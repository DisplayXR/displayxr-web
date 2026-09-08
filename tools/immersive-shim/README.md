# immersive-vr shim — validation spike

Serves `navigator.xr.requestSession('immersive-vr')` through the DisplayXR Browser's shipped
inline-3d path, in-tab, with no page changes. This is the **approach-2 spike** from
`displayxr-browser-pvt/docs/design/immersive-vr-emulation.md`: it exists to measure scene fit
and engine feature-detection against the real WebXR corpus before the Blink-native product is
built. It is not a product and must not ship as one.

## Install / run

1. Copy this folder somewhere the Chromium sandbox can read
   (`%LOCALAPPDATA%\DisplayXR\immersive-shim` is safe; a harness scratchpad may need
   `icacls <dir> /grant "*S-1-1-0:(OI)(CI)RX" /T`).
2. `launch.cmd [url]` — non-elevated. It uses its own profile so it never collides with an
   already-running DisplayXR Browser, and writes `%TEMP%\dxr_shim_chrome.log`.
3. Open a stock WebXR page and click its Enter VR button.

The console prints `[dxr-immersive-shim] armed` on every page; a HUD (top-right) shows the live
preset. `window.__dxrImmersiveShim` exposes `cfg`, `set(k,v)`, `preset(name)`, `log()`, `session`.

## In-session controls (the runtime's qwerty device, mirrored 1:1)

| Input | Action |
|---|---|
| W/A/S/D | move forward/left/back/right (1.4 m/s walk, Shift = run 4.3 m/s — human scale) |
| Q/E | down/up |
| Arrows or RMB-drag | look (yaw about world Y, pitch local). Fullscreen: the session pointer-locks the canvas from Enter VR (cursor hidden, raw deltas, like a hosted app); Esc frees it, any click re-locks. Windowed (in-place): no pointer lock at all (Chrome's "press Esc" bubble cannot be suppressed); a right-drag hides the cursor for the drag and uses the raw mouse deltas, the cursor reappears on release. In fullscreen the Escape key is keyboard-locked: a single **Esc frees the cursor only** (session and fullscreen continue), **holding Esc for ~2 s** exits fullscreen (Chrome's rule), and **F11** toggles fullscreen instantly |
| + / − (numpad or = / -) | movement speed ×/÷ 1.25 |
| P | toggle camera-centric ↔ display-centric (convergence plane stays put, `dxr_rig_toggle`) |
| wheel | camera mode: convergence ±0.05 dp (comfort-clamped); display mode: vHeight ×1.05 |
| Shift+wheel | IPD + parallax ×1.1 (comfort-clamped in camera mode) |
| Space | reset to the qwerty defaults (camera, 2 m, 36°) |
| V | 2D ↔ 3D rendering mode, eased like the cube apps / demos (`dxr::ModeSwitch` port: 0.18 s SmoothStep; 3D→2D ramps ipd to 0 then switches, 2D→3D switches then ramps up) |
| 1 / 2 / 3 | rendering mode by index |
| Tab | HUD on/off |
| hold Ctrl / Alt | focus the left / right controller for the MOUSE and buttons, exactly as qwerty (mouse XY translates it, RMB rotates it) |
| hold Z / X | same focus for the KEYBOARD (WASDQE / arrows / +/-) — Ctrl+W would close the tab, so keys need these |
| (focused) WASDQE, arrows, RMB, mouse XY | move / rotate / translate the focused controller(s) (qwerty controller speeds) |
| LMB / MMB | trigger (select) / squeeze on the focused controller(s), default right |
| T/F/G/H, V, N | thumbstick, thumbstick click (when focused), menu |
| C / R | toggle follow-HMD / reset pose (focused, else both) |

## Hotkeys (Ctrl+Alt+…)

| Key | Action |
|---|---|
| 0 | **legacy (default)** — the rig the runtime synthesises for a legacy WebXR client in stock Chrome (qwerty device defaults): camera rig, convergence 2 m (0.5 dp), 36° vFOV, ipd 1, parallax 1, m2v 1 |
| 1 / 2 / 3 / 4 / 5 | preset Portal (m2v 1) / Room (2) / Tabletop (3.3) / Wide (camera rig, 45° vFOV) / Scene (camera rig, panel FOV, ZDP 2.5 m into the scene — for headset content that has nothing near the glass) |
| [ / ] | m2v ÷/× 1.25 |
| , / . | ipdFactor −/+ 0.1 |
| ; / ' | parallaxFactor −/+ 0.1 |
| P | toggle fullscreen / in-place presentation (takes effect on the next session) |
| Q | qwerty emulation on/off |
| X | **exit VR**: ends the session and reloads the page, so it comes back in its pre-Enter-VR state (the landing page). Ctrl+Alt+Shift+X = soft exit (ends the session only; the page shows its own 2D fallback) |
| F | Flatten toggle (rendering mode viewCount 1 ↔ 2, needs a 0128 browser) |
| L | dump the feature-detect log as a table |
| H | toggle the HUD |

## Corpus (in order)

1. https://immersive-web.github.io/webxr-samples/ — `xr-barebones`, `input-tracking`
2. https://threejs.org/examples/webxr_vr_cubes.html, `webxr_vr_sandbox.html`
3. A-Frame hello-world (https://aframe.io/examples/showcase/helloworld/), a-painter
4. Babylon playground default XR experience
5. one PlayCanvas published demo
Control: `displayxr-web/samples/hello-cube`, `samples/model` (these must be unaffected).

## What to record per page

- feature-detect log (Ctrl+Alt+L) → the engine compatibility matrix (design doc §5)
- which preset / m2v / ipd looked right on the panel (a human eyeballs 2D/3D)
- `%LOCALAPPDATA%\DisplayXR\DisplayXR_chrome.exe.<pid>_*.log`:
  `VIEW-RIG IPC client: locate ok, rig_applied=… eyes=…` is the machine-checkable half
- chrome log: `weave rects from tracked elements: n=…`, `batch weave: n=… eyes_valid=1`

## Known limits of the spike (by design; the Blink product removes them)

- Reference spaces are rebased in JS with a constant floor offset (`cfg.floorY = -1.6`); the
  product creates real LOCAL/STAGE on the weave session (design §4.2).
- The stock takeover path is blocked only on pages where the extension runs.
- WebGL1 contexts get `framebuffer = null` (the app draws the canvas directly).
- `layers`, WebGPU, hand tracking, hit-test: unsupported (same as product v1).

## Status / provenance

Validation spike for [`displayxr-browser-pvt/docs/design/immersive-vr-emulation.md`](https://github.com/DisplayXR/displayxr-browser-pvt/blob/main/docs/design/immersive-vr-emulation.md)
(epic browser-pvt#55, spike issue #56). Everything it learned on hardware is recorded on that
epic's children. It is **not** shipped, not part of the SDK, and never will be: an
extension-shaped product repeats the WebXR Bridge v2 mistake. The Blink-native product
replaces it; the feel (qwerty mirror, eased 2D/3D, presets) is the contract it hands over.

Verified pages (2026-09-08, DisplayXR Browser 0.1.28, runtime v2.16.17-3): immersive-web
`immersive-vr-session`, `input-tracking`, `controller-state`; three.js sample; xrdinosaurs.com.

# js/ — inline-3D helper

**`displayxr-inline3d.js`** — a thin, dependency-free ES-module helper over the DisplayXR Browser's
`inline-3d` WebXR surface:

- `isInline3DSupported()` → `Promise<boolean>` (feature-detect: `navigator.xr` + `XRDisplayLayer` +
  `isSessionSupported('inline-3d')`).
- `startInline3D(canvas, { onFrame, referenceSpace })` → opens the sensorless inline session, binds an
  `XRDisplayLayer` to `canvas`, and calls `onFrame(views, layer, frame, pose)` each frame with the two
  off-axis eye views. Returns a handle with `.close()`, or `{ supported:false }` if inline-3D is
  unavailable (so you can fall back to a plain mono render).

Import it directly — no build step:
```js
import { startInline3D } from '../../js/displayxr-inline3d.js';
```
See `samples/hello-cube/app.js` for the full render loop (per-eye viewport + camera from
`view.projectionMatrix` / `view.transform`).

**`version-check.js`** — the DisplayXR Browser's lightweight update check (no silent auto-updater):
`checkForUpdate()` compares the running Chromium version against the latest `displayxr-browser` GitHub
Release; `showUpdateBanner()` renders a dismissible "new version → download" banner iff one exists. Meant
to run on the browser's start page. Never throws (offline / rate-limited / not-the-browser → no-op).

# The 3D camera — `@displayxr/inline3d/camera`

The stereo camera as a primitive: open the best camera (the DisplayXR Browser's "3D Camera" on a
3D laptop, a side-by-side USB pair, or the plain webcam), show a **correctly mirrored** 3D self
view, take a 3D photo, record a 3D clip. Captured files are plain side-by-side with the layout in
the name (`_2x1`) and the stereo record inside the file, so they open in [`/player`](../samples/player/)
and anything else that understands side-by-side. `/call` is built on this module: its self view
is an `addCameraView`, and `mountCall(el, { camera: cam })` takes a camera you opened here.

**Tier: preview.** `/camera` is not yet under the 1.x semver promise ([`sdk-stability.md`](sdk-stability.md)).
Design: [RFC 0003 §4](rfcs/0003-call-developer-experience.md#4-the-stereo-camera-as-its-own-primitive-displayxrinline3dcamera).
Demo: [`samples/camera/`](../samples/camera/).

---

## Quickstart

```js
import { sharedInline3D } from '@displayxr/inline3d';
import { openCamera, addCameraView } from '@displayxr/inline3d/camera';

const cam = await openCamera({ prefer: 'stereo' });   // 'auto' | 'stereo' | 'mono' | deviceId | MediaStream
cam.format;   // 'sbs' | 'mono'
cam.stereo;   // { rectified, baselineMm, horizontalFovDeg } | null
cam.stream;   // the MediaStream — hand it to WebRTC, a MediaRecorder, a canvas

const wall = await sharedInline3D();
const view = addCameraView(wall, document.querySelector('canvas'), cam, { mirror: true, autoConverge: true });

const photo = await cam.capturePhoto();               // { blob, suggestedName: 'photo-…_2x1.jpg', convergencePx, … }
const rec = cam.record({ mono: true });               // side-by-side + a left-eye copy for 2D platforms
const clip = await rec.stop();                        // { blob, mono, suggestedName: 'clip-…_2x1.webm', … }

cam.on('ended', () => console.log('camera revoked, unplugged, or taken by another app'));
cam.close();
```

On the DisplayXR Browser with a 3D display the self view is woven 3D. Anywhere else the same
code shows the left eye (or the mono picture), flat and mirrored, and still captures a real pair
when the camera is one.

---

## `openCamera(opts)`

| Option | Default | What |
|---|---|---|
| `prefer` | `'auto'` | `'auto'`: a stereo device when one is present — the DisplayXR Browser's "3D Camera" (recognised by its `displayxrStereo` track settings, never by its label) or a device delivering wider than 2.5:1 frames — else the default webcam. `'stereo'` prefers the pair and falls back; `'mono'` never probes; a `deviceId`; or a `MediaStream` you own |
| `format` | `'mono'` | The format of a page-supplied `MediaStream`. 3D-ness is never guessed from a stream |
| `calibration` | — | `{ baselineMm, horizontalFovDeg, rectified }` for a stream the device does not describe; a page value wins over the device's |
| `rectify` | — | `(stream, info) => MediaStream` — a calibrated rectification step for a raw pair; `stereo.rectified` is then true. A throwing hook keeps the raw pair (`cam.rectifyError`) |
| `debug` | `false` | Verbose console logging |

`openCamera('stereo')` and `openCamera(mediaStream)` are shorthands for `prefer`.

A camera held by another process — on 3D laptops, usually the eye tracker — is skipped, never
fatal. The promise rejects only when **no** camera opens, with `error.code`:

| Code | Meaning → fix |
|---|---|
| `camera-busy` | Every device that exists is held by another app. Try again once it is free, or pass a `deviceId` |
| `permission-denied` | The prompt was refused, a policy forbids it, or the context is insecure (`http://` on a LAN IP). Serve over `https://` / `localhost`; reset the site's camera permission |
| `no-camera` | No device, or every open failed for another reason |

`error.skipped` lists each device tried and why it was not used.

### The camera

```ts
import type { StereoCamera } from '@displayxr/inline3d/camera';

declare const cam: StereoCamera;
cam.format;      // 'sbs' | 'mono'
cam.stereo;      // { rectified, baselineMm, horizontalFovDeg } | null
cam.stream;      // MediaStream, never mirrored
cam.width;       // the frame (two eyes wide for a pair); cam.eyeWidth is one eye's
cam.height;
cam.label;       // the device's label ('' until permission)
cam.owned;       // true when this module opened the device (close() stops it)
cam.state;       // 'live' | 'ended' | 'closed'
cam.video;       // a detached, playing <video> on the stream (never in the DOM)
```

`cam.on('ended', cb)` fires once when the camera ends under you — revoked by the runtime,
unplugged, taken by another app. `close()` never fires it. `close()` stops the tracks this
module opened (a page-supplied stream is left running) and removes every view of the camera.

---

## `addCameraView(wall, canvas, cam, opts)` — the self view

```js
import { sharedInline3D } from '@displayxr/inline3d';
import { openCamera, addCameraView } from '@displayxr/inline3d/camera';

const cam = await openCamera();
const view = addCameraView(await sharedInline3D(), document.querySelector('canvas'), cam, {
  mirror: true,          // selfie mirroring, done right for a pair (default true)
  autoConverge: true,    // the face at the display plane (default false)
  depth: 0,              // [-1, 1], + = push back — an offset on top of the convergence
  aspect: 16 / 9,        // the tile's aspect = the woven buffer's per-eye aspect
});
view.route;              // 'woven-sbs' | 'flat-left' | 'flat'
view.woven;              // true only while on the woven route (a failed layer takes it flat)
view.setDepth(0.2);  view.setMirror(false);  view.setAutoConverge(false);
view.remove();           // leave the wall; the camera stays open
```

**Mirroring a stereo pair is not what it looks like.** A mirror shows your left eye what your
right eye would see, reflected. So a mirrored self view is each half mirrored **and the halves
swapped** — the same pixels as flipping the whole side-by-side frame. Mirroring each half in place
keeps the eyes where they were and inverts every disparity: the face comes out inside-out
(pseudoscopic). `addCameraView` does it right; the stream that is sent or recorded is never
touched. (The unit test pins this with a synthetic pair: a subject in front of the screen stays
in front.)

The canvas is a woven tile and must obey the [woven-canvas rules](woven-canvas-rules.md): its CSS
box is the shape the viewer sees, no `filter` / `opacity` / `border-radius` on it or any
ancestor, controls below or beside it. On a 2D wall (any other browser) the view is the left eye,
flat and mirrored; `view.route` says which.

**A tile the wall will not weave falls back to the left eye, never to the packed pair.** On a 3D
wall the view follows its tile's `firstWoven`: if the browser refuses the layer
(`'layer-failed'`) or the session ends under it (`'session-ended'`), the view drops to
`'flat-left'` by itself, `view.woven` goes false and `view.fallbackReason` says why. A refused
layer is re-registered a few times with backoff while the wall stays up; after a session ended the
view waits for a new wall. Put a "3D" badge on `view.woven` (or listen with `onRouteChange`), not
on whether the wall is 3D — a canvas the browser is not weaving shows its side-by-side buffer as
ordinary 2D, which is the squeezed-pair look ([web#131](https://github.com/DisplayXR/displayxr-web/issues/131)).

```js
const view = addCameraView(wall, canvas, cam, {
  onRouteChange: (route, state) => (badge.textContent = view.woven ? '3D' : '2D'),
});
view.weaveState(); // { route, woven, reason, firstWoven: {…} | 'pending' | null, layerRetries }
```

`firstWoven` is the SDK's worst-case timer, not a report from the browser (no browser says when
its compositor joined a canvas), so this catches every failure the page *can* see; a layer the
browser silently never joins still reads as woven.

---

## `capturePhoto()` and `record()`

```js
import { openCamera } from '@displayxr/inline3d/camera';
const cam = await openCamera();

const photo = await cam.capturePhoto({ type: 'image/jpeg', quality: 0.92 });
// photo.blob            the file: the RAW pair, never mirrored, never shifted
// photo.layout          'sbs' | 'mono'
// photo.width, height   the whole frame (an SBS photo is two eyes wide)
// photo.convergencePx   disparity of the face (left-eye x − right-eye x, source px), or null
// photo.suggestedName   'photo-20260101-120000_2x1.jpg'  (no suffix for mono)
// photo.xmp             the XMP packet written into the JPEG

const a = document.createElement('a');
a.href = URL.createObjectURL(photo.blob);
a.download = photo.suggestedName;
a.click();
```

```js
import { openCamera } from '@displayxr/inline3d/camera';
const cam = await openCamera();

const rec = cam.record({ mono: true, audio: micStream });   // mimeType: the first WebM the browser supports
rec.state;                                                  // 'recording' | 'paused' | 'inactive'
const clip = await rec.stop();
// clip.blob            the side-by-side recording (a WebM carries the record as DXR_* tags)
// clip.mono            with mono: true — a left-eye copy for 2D platforms (Decision 13)
// clip.suggestedName   'clip-20260101-120000_2x1.webm';  clip.monoSuggestedName  'clip-….webm'
// clip.convergencePx   the median of the face's disparity while recording
```

**Photos store the raw pair; the convergence rides alongside.** Baking the shift into the pixels
would crop the edges, so the file keeps the rectified pair as the camera delivered it and records
`convergencePx` — a viewer shifts the two eyes toward each other by half of it each to put the
face at the display plane (`/player` and `/call` do exactly that with their own measurement).

**The record is in the file** (RFC 0003 Decision 9 — no sidecar):

| | JPEG (`image/jpeg`) | WebM |
|---|---|---|
| Where | an APP1 XMP packet, namespace `http://displayxr.org/ns/stereo/1.0/` (`dxr:`) | a Matroska `Tags` element, `DXR_*` SimpleTags |
| Fields | `Layout` (`side-by-side`/`mono`), `Columns`, `Rows`, `ConvergencePx`, `BaselineMm`, `HorizontalFovDeg`, `Rectified`, `EyeWidth`, `EyeHeight`, `Software` | `DXR_LAYOUT`, `DXR_COLUMNS`, `DXR_ROWS`, `DXR_CONVERGENCE_PX`, `DXR_BASELINE_MM`, `DXR_HFOV_DEG`, `DXR_RECTIFIED`, `DXR_EYE_WIDTH`, `DXR_EYE_HEIGHT`, `DXR_SOFTWARE` |
| Read it back | `readJpegStereoMeta(bytes)` | `readWebmStereoMeta(bytes)` |

PNG / WebP photos and MP4 recordings carry no record (the result still reports it). The file
name's `_2x1` suffix is the layout `/player` reads — columns × rows, left eye left — and is the
one thing every consumer agrees on.

```js
import { readJpegStereoMeta } from '@displayxr/inline3d/camera';
const meta = readJpegStereoMeta(new Uint8Array(await photo.blob.arrayBuffer()));
// { layout: 'sbs', columns: 2, rows: 1, convergencePx, baselineMm, horizontalFovDeg, rectified, eyeWidth, eyeHeight, software }
```

---

## With a call

```js
import { mountCall } from '@displayxr/inline3d/call';
import { openCamera } from '@displayxr/inline3d/camera';

const cam = await openCamera({ prefer: 'stereo', calibration: { baselineMm: 63, horizontalFovDeg: 70 } });
const call = await mountCall(document.getElementById('call'), { camera: cam });
// …the same camera, for a selfie mid-call:
const photo = await cam.capturePhoto();
```

With `camera: 'auto'` (the default) the call opens a camera itself and closes it when it ends; a
camera you pass in is left open. `calibration` and `rectify` live here now — they were `/call`
options in 1.29.

## What is not here

2D→3D of a mono camera (that is [`/lift`](../js/lift/)'s job and composes: `lift(cam.video)`),
and any network code. Mono cameras are mono cameras: `capturePhoto()` on one produces a plain
`photo-….jpg`.

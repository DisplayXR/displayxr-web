# 3D video player (`samples/video/`)

An **embeddable** glasses-free-3D video player built on `wall.addVideo()`:
play/pause, loop, scrubber, mute, and fullscreen. Reusable module at
[`js/inline3d-player.js`](../../js/inline3d-player.js) (`@displayxr/inline3d/player`).

## Use it

```html
<script type="module">import '@displayxr/inline3d/player';</script>
<dxr-video-player src="movie_sbs.webm" loop autoplay></dxr-video-player>
```

or from JS:

```js
import { createVideoPlayer } from '@displayxr/inline3d/player';
const p = createVideoPlayer(hostEl, { src: 'movie_sbs.webm', loop: true });
p.play(); p.pause(); p.setLoop(true); p.seek(10); p.enterFullscreen();
```

Attributes: `src` (required), `loop`, `autoplay`, `unmuted`, `poster`, `corner-radius`.
Keyboard: **space/k** play·pause, **f** fullscreen, **m** mute, **l** loop, **←/→** ±5s.

On the DisplayXR Browser the SBS pair is woven to glasses-free 3D; on any other
browser the player shows the **left eye** as an ordinary 2D video (same controls),
so the embed is safe to publish anywhere.

## Source format

- **Side-by-side**, left eye = **left** half.
- **VP9/WebM** — *not* H.264/MP4. Stock Chromium (the browser's base) ships with
  `proprietary_codecs` off, so an `.mp4` fails with `MEDIA_ERR_SRC_NOT_SUPPORTED`.
- **~640×360 per eye** is the practical ceiling: the 3D panel renders at ~0.5×0.5
  scale, so more resolution is download weight the weave discards.
- Remote `src` must be **CORS-enabled** (the SDK draws each frame into a canvas;
  a cross-origin frame without CORS taints it and throws).

## Make an SBS WebM with ffmpeg

From two eye videos (left + right):

```sh
ffmpeg -i left.mp4 -i right.mp4 -filter_complex \
 "[0:v]scale=640:360[l];[1:v]scale=640:360[r];[l][r]hstack=inputs=2[v]" \
 -map "[v]" -c:v libvpx-vp9 -b:v 0 -crf 30 -an out_sbs.webm
```

From an existing full-SBS source (e.g. 3840×1080):

```sh
ffmpeg -i in_sbs.mp4 -vf scale=1280:360 -c:v libvpx-vp9 -b:v 0 -crf 30 -an out_sbs.webm
```

(A single 2D clip can't become real stereo without depth — you need a true pair.)

## Run locally

```sh
python3 -m http.server 8000        # from the repo root
# open http://localhost:8000/samples/video/
```

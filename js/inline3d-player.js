// @displayxr/inline3d/player — an embeddable glasses-free-3D video player.
//
// Drop-in stereo (side-by-side) video player with play/pause, loop, scrubber,
// mute and fullscreen. Wraps wall.addVideo(): the SDK weaves the SBS pair into a
// canvas on DisplayXR hardware; everywhere else the player shows the left eye as
// an ordinary 2D video, so the same embed is safe on any browser.
//
// Two ways to embed:
//
//   // 1. HTML custom element
//   <script type="module" src=".../inline3d-player.js"></script>
//   <dxr-video-player src="movie_sbs.webm" loop autoplay style="width:640px"></dxr-video-player>
//
//   // 2. JS factory
//   import { createVideoPlayer } from '@displayxr/inline3d/player';
//   const p = createVideoPlayer(hostEl, { src: 'movie_sbs.webm', loop: true });
//
// SOURCE FORMAT: a full side-by-side video (left eye = LEFT half), VP9/WebM
// (stock Chromium — the DisplayXR Browser base — has proprietary_codecs off, so
// .mp4/H.264 fails with MEDIA_ERR_SRC_NOT_SUPPORTED). ~640x360 per eye is the
// practical ceiling: the 3D panel renders at ~0.5x0.5 scale, so higher is just
// download weight the weave discards. For a remote src, serve it with CORS
// headers — the SDK draws each frame into a canvas and a tainted frame throws.

import { createInline3D, inline3dOcclusionByDrawOrder } from './inline3d.js';

// The SDK wants ONE createInline3D() per document (it warns otherwise), so every
// player on the page shares a single session/wall and adds its own video tile.
let _wallPromise = null;
function sharedWall() {
  if (!_wallPromise) _wallPromise = createInline3D();
  return _wallPromise;
}

let _styleInjected = false;
function injectStyleOnce() {
  if (_styleInjected || typeof document === 'undefined') return;
  _styleInjected = true;
  const css = `
.dxrvp{position:relative;display:block;width:100%;aspect-ratio:16/9;background:#000;
  overflow:hidden;border-radius:12px;font:14px/1.2 system-ui,sans-serif;color:#fff;
  -webkit-user-select:none;user-select:none}
.dxrvp:fullscreen{border-radius:0}
.dxrvp canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.dxrvp video{position:absolute;top:0;left:0;height:100%;width:200%;object-fit:fill;
  display:none}                    /* 3D: video is drawn into the canvas, kept for decode */
.dxrvp[data-dxr3d="off"] canvas{display:none}
.dxrvp[data-dxr3d="off"] video{display:block}   /* 2D fallback: width:200% clips to left eye */
.dxrvp .dxrvp-center{position:absolute;inset:0;display:grid;place-items:center;
  background:rgba(0,0,0,.25);cursor:pointer;transition:opacity .2s}
.dxrvp .dxrvp-center svg{width:72px;height:72px;filter:drop-shadow(0 2px 8px rgba(0,0,0,.6))}
.dxrvp[data-playing="1"] .dxrvp-center{opacity:0;pointer-events:none}
.dxrvp .dxrvp-bar{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;
  gap:10px;padding:10px 12px;background:linear-gradient(transparent,rgba(0,0,0,.65));
  transition:opacity .25s;opacity:1}
.dxrvp[data-chrome="hidden"] .dxrvp-bar{opacity:0;pointer-events:none}
.dxrvp .dxrvp-btn{background:none;border:0;padding:4px;cursor:pointer;color:#fff;
  display:inline-flex;line-height:0;border-radius:6px}
.dxrvp .dxrvp-btn:hover{background:rgba(255,255,255,.15)}
.dxrvp .dxrvp-btn svg{width:22px;height:22px}
.dxrvp .dxrvp-btn[aria-pressed="true"]{color:#4ea1ff}
.dxrvp .dxrvp-seek{flex:1;height:4px;accent-color:#4ea1ff;cursor:pointer}
.dxrvp .dxrvp-time{font-variant-numeric:tabular-nums;font-size:12px;opacity:.9;min-width:82px;
  text-align:center}
.dxrvp .dxrvp-badge{position:absolute;top:8px;left:8px;font-size:11px;letter-spacing:.03em;
  padding:2px 8px;border-radius:99px;background:rgba(0,0,0,.5);opacity:.8}`;
  const s = document.createElement('style');
  s.id = 'dxrvp-style';
  s.textContent = css;
  document.head.appendChild(s);
}

// Minimal inline icons (currentColor).
const I = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  loop: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 7h9V4l5 5-5 5V11H9v3H7zM17 17H8v3l-5-5 5-5v3h9v3z"/></svg>',
  mute: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 9v6h4l5 5V4L8 9zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z" opacity=".35"/><path d="M19 5 5 19" stroke="currentColor" stroke-width="2"/></svg>',
  vol: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 9v6h4l5 5V4L8 9zm11 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zm-2.5-8v2.1A7 7 0 0 1 12.5 20v2A9 9 0 0 0 12.5 4z"/></svg>',
  fs: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 9V4h5v2H6v3zm11-5h5v5h-2V6h-3zM6 15v3h3v2H4v-5zm12 3v-3h2v5h-5v-2z"/></svg>',
  fsExit: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 7V4H5v5h5V7zm10 0h-3v2h5V4h-2zM7 17h3v-2H5v5h2zm10 0v-3h-2v5h5v-2z"/></svg>',
};

function fmt(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/**
 * Build an embeddable 3D video player inside `host`.
 * @param {HTMLElement} host  container the player fills (give it a width/aspect).
 * @param {object} opts
 * @param {string} opts.src  side-by-side VP9/WebM URL (left eye = left half).
 * @param {boolean} [opts.loop=true]
 * @param {boolean} [opts.muted=true]     muted is required for autoplay.
 * @param {boolean} [opts.autoplay=false]
 * @param {string}  [opts.poster]         poster image URL.
 * @param {{width:number,height:number}} [opts.perEye={width:640,height:360}]  per-eye buffer px.
 * @param {number}  [opts.cornerRadius=16]  per-eye rounded corners, buffer px (0 in fullscreen).
 * @param {boolean} [opts.controls=true]
 * @returns {{el:HTMLElement, video:HTMLVideoElement, play():void, pause():void,
 *   toggle():void, setLoop(on:boolean):void, seek(sec:number):void,
 *   enterFullscreen():void, destroy():void}}
 */
export function createVideoPlayer(host, opts = {}) {
  injectStyleOnce();
  const {
    src, poster = null, loop = true, muted = true, autoplay = false,
    perEye = { width: 640, height: 360 }, cornerRadius = 16, controls = true,
  } = opts;
  if (!src) throw new Error('[inline3d/player] createVideoPlayer: opts.src is required');

  host.classList.add('dxrvp');
  host.setAttribute('data-dxr3d', 'off');   // becomes 'on' once a 3D session is acquired
  host.setAttribute('tabindex', '0');
  host.innerHTML = '';

  const canvas = document.createElement('canvas');

  const video = document.createElement('video');
  video.src = src;
  video.loop = loop;
  video.muted = muted;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';            // so the SDK can drawImage a CORS-served src
  if (poster) video.poster = poster;

  host.appendChild(canvas);
  host.appendChild(video);

  const badge = el('div', 'dxrvp-badge', '2D');
  host.appendChild(badge);

  // Center play/pause affordance.
  const center = el('div', 'dxrvp-center');
  center.innerHTML = I.play;
  host.appendChild(center);

  // Control bar.
  const bar = el('div', 'dxrvp-bar');
  const bPlay = btn(I.play, 'Play/pause');
  const seek = document.createElement('input');
  seek.type = 'range'; seek.min = '0'; seek.max = '1000'; seek.value = '0';
  seek.className = 'dxrvp-seek'; seek.setAttribute('aria-label', 'Seek');
  const time = el('div', 'dxrvp-time', '0:00 / 0:00');
  const bLoop = btn(I.loop, 'Loop'); bLoop.setAttribute('aria-pressed', String(loop));
  const bMute = btn(muted ? I.mute : I.vol, 'Mute'); bMute.setAttribute('aria-pressed', String(muted));
  const bFull = btn(I.fs, 'Fullscreen');
  bar.append(bPlay, seek, time, bLoop, bMute, bFull);
  if (controls) host.appendChild(bar);

  const overlayEls = [center, bar];       // 2D chrome the weave must leave crisp
  let handle = null, scrubbing = false, hideTimer = 0;

  // ---- control wiring (drives the <video>) ----
  const play = () => video.play().catch(() => {});
  const pause = () => video.pause();
  const toggle = () => (video.paused ? play() : pause());
  const setLoop = (on) => { video.loop = on; bLoop.setAttribute('aria-pressed', String(on)); };
  const seekTo = (sec) => { if (isFinite(sec)) video.currentTime = sec; };
  const enterFullscreen = () => {
    if (document.fullscreenElement === host) document.exitFullscreen?.();
    else host.requestFullscreen?.();
  };

  bPlay.onclick = toggle;
  center.onclick = toggle;
  bLoop.onclick = () => setLoop(!video.loop);
  bMute.onclick = () => {
    video.muted = !video.muted;
    bMute.setAttribute('aria-pressed', String(video.muted));
    bMute.innerHTML = video.muted ? I.mute : I.vol;
  };
  bFull.onclick = enterFullscreen;
  seek.addEventListener('input', () => {
    scrubbing = true;
    if (video.duration) video.currentTime = (seek.value / 1000) * video.duration;
  });
  seek.addEventListener('change', () => { scrubbing = false; });

  // Keyboard: space/k play, f fullscreen, m mute, l loop, arrows seek.
  host.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'k') { e.preventDefault(); toggle(); }
    else if (k === 'f') enterFullscreen();
    else if (k === 'm') bMute.onclick();
    else if (k === 'l') setLoop(!video.loop);
    else if (k === 'arrowright') seekTo(video.currentTime + 5);
    else if (k === 'arrowleft') seekTo(video.currentTime - 5);
  });

  // ---- reflect <video> state into the UI ----
  const onPlay = () => { host.setAttribute('data-playing', '1'); bPlay.innerHTML = I.pause; scheduleHide(); };
  const onPause = () => { host.setAttribute('data-playing', '0'); bPlay.innerHTML = I.play; showChrome(); };
  const onTime = () => {
    if (!scrubbing && video.duration) seek.value = String((video.currentTime / video.duration) * 1000);
    time.textContent = `${fmt(video.currentTime)} / ${fmt(video.duration)}`;
  };
  video.addEventListener('play', onPlay);
  video.addEventListener('pause', onPause);
  video.addEventListener('timeupdate', onTime);
  video.addEventListener('durationchange', onTime);
  video.addEventListener('ended', () => { if (!video.loop) onPause(); });

  // Auto-hide the bar while playing.
  function showChrome() { host.removeAttribute('data-chrome'); scheduleHide(); }
  function scheduleHide() {
    clearTimeout(hideTimer);
    if (video.paused) return;
    hideTimer = setTimeout(() => host.setAttribute('data-chrome', 'hidden'), 2600);
  }
  host.addEventListener('pointermove', showChrome);
  host.addEventListener('pointerleave', () => { if (!video.paused) host.setAttribute('data-chrome', 'hidden'); });

  // Fullscreen: drop corner rounding while filling the screen.
  const onFsChange = () => {
    const fs = document.fullscreenElement === host;
    bFull.innerHTML = fs ? I.fsExit : I.fs;
    if (handle && handle.setCornerRadius) handle.setCornerRadius(fs ? 0 : cornerRadius);
  };
  document.addEventListener('fullscreenchange', onFsChange);

  // ---- acquire the 3D session and weave (or fall back to 2D) ----
  sharedWall().then((wall) => {
    if (wall && wall.supported) {
      handle = wall.addVideo(canvas, video, {
        width: perEye.width, height: perEye.height, cornerRadius,
      });
      host.setAttribute('data-dxr3d', 'on');
      badge.textContent = '3D';
      // On legacy browsers 2D chrome must be excluded from the weave; on modern
      // ones draw-order occlusion handles it and exclude() is a stored no-op.
      if (!(inline3dOcclusionByDrawOrder && inline3dOcclusionByDrawOrder())) {
        overlayEls.forEach((n) => handle.exclude && handle.exclude(n));
      }
    } else {
      host.setAttribute('data-dxr3d', 'off');   // 2D: CSS crops the SBS video to the left eye
      badge.textContent = '2D';
    }
    if (autoplay) play();
  });

  function destroy() {
    clearTimeout(hideTimer);
    document.removeEventListener('fullscreenchange', onFsChange);
    try { handle && handle.remove(); } catch {}
    try { video.pause(); video.removeAttribute('src'); video.load(); } catch {}
    host.innerHTML = '';
    host.classList.remove('dxrvp');
  }

  return { el: host, video, play, pause, toggle, setLoop, seek: seekTo, enterFullscreen, destroy };
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function btn(svg, label) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'dxrvp-btn'; b.title = label;
  b.setAttribute('aria-label', label); b.innerHTML = svg;
  return b;
}

// ---- <dxr-video-player src="..." loop autoplay poster="..."> ----
class DxrVideoPlayer extends HTMLElement {
  connectedCallback() {
    if (this._player || !this.getAttribute('src')) return;
    this._player = createVideoPlayer(this, {
      src: this.getAttribute('src'),
      poster: this.getAttribute('poster') || null,
      loop: this.hasAttribute('loop'),
      muted: !this.hasAttribute('unmuted'),
      autoplay: this.hasAttribute('autoplay'),
      cornerRadius: this.hasAttribute('corner-radius') ? +this.getAttribute('corner-radius') : 16,
    });
  }
  disconnectedCallback() { this._player && this._player.destroy(); this._player = null; }
  play() { this._player && this._player.play(); }
  pause() { this._player && this._player.pause(); }
  get video() { return this._player && this._player.video; }
}
if (typeof customElements !== 'undefined' && !customElements.get('dxr-video-player')) {
  customElements.define('dxr-video-player', DxrVideoPlayer);
}

export { DxrVideoPlayer };

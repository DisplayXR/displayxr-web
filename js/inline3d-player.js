// inline3d-player.js — a media player as an inline-3D window, in one call.
//
// PREVIEW tier. Not covered by the SDK's 1.x semver promise — see docs/sdk-stability.md.
// Implements the v1 slice of docs/rfcs/0001-media-player.md; see the report that shipped this
// file for the deviations from that RFC (they are real, not cosmetic — read them before you
// reach for `untrackedFallback` or `opts.group`, neither of which exists here).
//
//   import { createInline3D } from '@displayxr/inline3d';
//   import { addPlayer } from '@displayxr/inline3d/player';
//
//   const wall = await createInline3D();
//   const p = addPlayer(wall, canvas, 'title-sbs.webm', { poster: 'title-poster.jpg' });
//   p.on('ready', () => p.play());
//
// Built ON `wall.addVideo()`: for `format:'sbs'` on a supported wall, this module creates and
// owns a hidden <video> and hands it straight to `wall.addVideo(canvas, video, opts)` — the
// stereo paint (the per-frame drawImage), the SBS buffer sizing, and the display-mode plumbing
// are `addVideo`'s, unchanged. This file adds exactly two things on top: a small canvas-owned
// paint loop for the cases `addVideo` cannot cover (below), and the SDK-drawn transport chrome.
//
// ── WHY THE "MONO" PATH LOOKS THE WAY IT DOES, NOT THE RFC's WAY ──────────────────────────
//
// The RFC says the mono fallback is "zero new code" because it reuses `wall`'s
// `untrackedFallback: 'mono'` option and `wall.trackingState`. THAT MECHANISM DOES NOT EXIST IN
// THIS CODEBASE (checked: no `untrackedFallback`, no `trackingState`, no `trackingstatechange`
// anywhere in js/ or docs/). What DOES exist is `win.sbs` + `Inline3D._paintMono()` — an
// INTERNAL, non-configurable fallback the manager applies to a window whose weave layer isn't
// live (off-screen in lazy mode, an unsupported browser, or a layer that failed to construct):
// draw the left half of the source, stretched, into a 1:1 buffer. It fires automatically and
// for free under `format:'sbs'` — nothing here needs to ask for it — but a page CANNOT ask a
// live, woven window to render this way, so it cannot carry `format:'mono'`'s job: content that
// is genuinely flat and should never be split into eyes, independent of whether the browser
// can weave.
//
// So: `format:'sbs'` calls `wall.addVideo()` unchanged, and inherits every real fallback it
// already has, including the internal one above. `format:'mono'` — and `format:'sbs'` on an
// absent/unsupported wall, where `wall.addVideo` does not even exist to call — instead run a
// small paint loop this module owns, using the SAME visual convention as the SDK's internal
// fallback (flat, 1:1, left-eye-only for content that IS a stereo pair but can't be woven; the
// WHOLE frame for content that is genuinely 2D). Feeding a deliberately-flat source through
// `addVideo` as a fake zero-disparity SBS pair was considered and rejected for v1: `addVideo`
// requires a real `<video>`, so faking it would mean re-encoding the source through a
// canvas-captured MediaStream into a second hidden `<video>` — real engineering, not "wire it
// and document it," and out of scope here.

/** @typedef {'sbs'|'mono'} PlayerFormat */

const VALID_FORMATS = new Set(['sbs', 'mono']);
const VALID_CONTROLS = new Set(['sdk', 'none']);

function pickEnum(value, allowed, fallback, label) {
  if (value === undefined) return fallback;
  if (allowed.has(value)) return value;
  console.warn(`[inline3d/player] invalid ${label} "${value}" — using "${fallback}"`);
  return fallback;
}

/**
 * Apply defaults and validate enum options. Pure (no DOM), so it is unit-testable without a
 * browser — see test/player-options.test.mjs.
 * @param {object} [opts]
 */
export function normalizePlayerOptions(opts = {}) {
  return {
    format: pickEnum(opts.format, VALID_FORMATS, 'sbs', 'format'),
    controls: pickEnum(opts.controls, VALID_CONTROLS, 'sdk', 'controls'),
    poster: opts.poster || null,
    autoplay: !!opts.autoplay,
    muted: opts.muted === undefined ? true : !!opts.muted,
    loop: !!opts.loop,
    keyboard: opts.keyboard === undefined ? true : !!opts.keyboard,
    // Accepted, not implemented in v1 — see the module doc comment above setSource() below.
    fadeMs: typeof opts.fadeMs === 'number' && opts.fadeMs > 0 ? opts.fadeMs : 0,
    crossOrigin: opts.crossOrigin,
    width: opts.width,
    height: opts.height,
    cornerRadius: opts.cornerRadius,
    feather: opts.feather,
    observe: opts.observe,
  };
}

/**
 * Format a time in seconds as `M:SS`, or `H:MM:SS` past an hour. Pure. NaN/negative/Infinity
 * (duration before metadata loads, a live stream) render as `0:00` rather than `NaN:NaN`.
 * @param {number} seconds
 */
export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * The keyboard map: Space/K play-pause, arrows seek ±5 s, J/L seek ±10 s, M mute. Pure — takes
 * `KeyboardEvent.key`, returns an action name or null for an unmapped key (so the caller does
 * nothing, in particular never calls `preventDefault()`, and Tab / other keys behave normally).
 * @param {string} key
 */
export function mapKeyToAction(key) {
  switch (key) {
    case ' ':
    case 'Spacebar':
    case 'Space':
    case 'k':
    case 'K':
      return 'toggle';
    case 'ArrowLeft':
      return 'seek-5';
    case 'ArrowRight':
      return 'seek+5';
    case 'j':
    case 'J':
      return 'seek-10';
    case 'l':
    case 'L':
      return 'seek+10';
    case 'm':
    case 'M':
      return 'mute';
    default:
      return null;
  }
}

function resolveSrcUrl(src) {
  if (typeof src === 'string') return src;
  if (typeof Blob !== 'undefined' && src instanceof Blob) return URL.createObjectURL(src);
  return src;
}

function resolveCrossOrigin(src, explicit) {
  if (explicit !== undefined) return explicit || null;
  if (typeof src !== 'string' || typeof location === 'undefined') return null;
  try {
    const url = new URL(src, location.href);
    if (url.origin !== location.origin) return 'anonymous';
  } catch {
    /* relative or unparsable — same-origin */
  }
  return null;
}

/** Duplicate `img` into BOTH halves of an already-sized SBS buffer — zero disparity, flat. */
function paintPosterSBS(canvas, img) {
  const w = canvas.width;
  const h = canvas.height;
  if (!w || !h) return false;
  const ctx = canvas.getContext('2d');
  const halfW = w / 2;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, halfW, h);
  ctx.drawImage(img, halfW, 0, halfW, h);
  return true;
}

/**
 * Paint the poster into a LIVE, woven SBS window until the video has a real frame to show, or
 * ~3 s pass. Bounded and self-terminating on purpose ("measure nothing, just wire it") — a
 * canvas that is still 0×0 when this gives up (an off-screen lazy tile that hasn't activated
 * yet) simply shows nothing until it does, exactly as an addVideo/addImage window with no
 * poster support already would.
 */
function startPosterPoll(canvas, getPoster, isVideoReady) {
  let frames = 0;
  const MAX_FRAMES = 180;
  function tick() {
    if (isVideoReady() || frames++ > MAX_FRAMES) return;
    const img = getPoster();
    if (img) paintPosterSBS(canvas, img);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

/**
 * The paint loop this module owns for `format:'mono'`, and for `format:'sbs'` on an
 * absent/unsupported wall (see the module doc comment for why). Sizes the canvas to its CSS
 * box × devicePixelRatio (capped at 2, the same convention `addImage`/`addVideo` use), redraws
 * on box changes, and — once the video is decoding — paints only on a NEW frame via
 * `requestVideoFrameCallback` where available, falling back to an every-frame `drawImage` loop
 * where it is not.
 */
function attachFlatPaint(canvas, video, { mode, getPoster }) {
  const ctx = canvas.getContext('2d');
  let stopped = false;
  let rafId = 0;
  let rvfcId = 0;
  let ro = null;

  function sizeCanvas() {
    const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2);
    const rect = canvas.getBoundingClientRect
      ? canvas.getBoundingClientRect()
      : { width: canvas.clientWidth, height: canvas.clientHeight };
    const w = Math.max(1, Math.round((rect.width || canvas.clientWidth || 300) * dpr));
    const h = Math.max(1, Math.round((rect.height || canvas.clientHeight || 150) * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
  }

  function draw() {
    if (stopped) return;
    const w = canvas.width;
    const h = canvas.height;
    if (!w || !h) return;
    if (video.readyState >= 2 && video.videoWidth) {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      ctx.clearRect(0, 0, w, h);
      if (mode === 'sbs-fallback') ctx.drawImage(video, 0, 0, vw / 2, vh, 0, 0, w, h);
      else ctx.drawImage(video, 0, 0, vw, vh, 0, 0, w, h);
      return;
    }
    const poster = getPoster();
    if (poster) {
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(poster, 0, 0, w, h);
    }
  }

  function loop() {
    if (stopped) return;
    draw();
    if (video.readyState >= 2 && typeof video.requestVideoFrameCallback === 'function') {
      rvfcId = video.requestVideoFrameCallback(loop);
    } else {
      rafId = requestAnimationFrame(loop);
    }
  }

  sizeCanvas();
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => {
      sizeCanvas();
      draw();
    });
    ro.observe(canvas);
  }
  loop();

  return {
    stop() {
      stopped = true;
      if (rafId) cancelAnimationFrame(rafId);
      if (rvfcId && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(rvfcId);
      }
      ro?.disconnect();
    },
    forceRepaint() {
      sizeCanvas();
      draw();
    },
  };
}

// ── SDK-drawn transport chrome ──────────────────────────────────────────────────────────────

let styleInjected = false;
const PLAYER_STYLE_ID = 'dxr-player-style';
const PLAYER_CSS = `
.dxr-player-bar{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;
  gap:8px;padding:6px 10px;background:rgba(12,13,16,.72);color:#fff;
  font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;box-sizing:border-box;
  opacity:1;transition:opacity .15s ease;}
.dxr-player-bar--hidden{opacity:0;pointer-events:none;}
@media (prefers-reduced-motion: reduce){.dxr-player-bar{transition:none;}}
.dxr-player-btn{appearance:none;-webkit-appearance:none;border:0;background:transparent;
  color:inherit;width:26px;height:26px;padding:4px;border-radius:5px;cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;flex:none;}
.dxr-player-btn svg{width:100%;height:100%;fill:currentColor;}
.dxr-player-btn:hover{background:rgba(255,255,255,.14);}
.dxr-player-btn:focus-visible{outline:2px solid #5aa8ff;outline-offset:2px;}
.dxr-player-time,.dxr-player-dur{font-variant-numeric:tabular-nums;min-width:3.4em;
  text-align:center;opacity:.85;}
.dxr-player-seek{flex:1 1 auto;appearance:none;-webkit-appearance:none;height:4px;
  border-radius:2px;background:rgba(255,255,255,.25);margin:0;}
.dxr-player-seek:focus-visible{outline:2px solid #5aa8ff;outline-offset:4px;}
.dxr-player-seek::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:12px;
  height:12px;border-radius:50%;background:#5aa8ff;cursor:pointer;margin-top:-4px;}
.dxr-player-seek::-moz-range-thumb{width:12px;height:12px;border-radius:50%;background:#5aa8ff;
  border:0;cursor:pointer;}
.dxr-player-seek::-moz-range-progress{background:#5aa8ff;height:4px;border-radius:2px;}
`;

function ensureStyle() {
  if (styleInjected || typeof document === 'undefined') return;
  styleInjected = true;
  if (document.getElementById(PLAYER_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = PLAYER_STYLE_ID;
  style.textContent = PLAYER_CSS;
  document.head.appendChild(style);
}

const PLAY_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 2.2v11.6a.6.6 0 0 0 .93.5l9.2-5.8a.6.6 0 0 0 0-1L4.93 1.7a.6.6 0 0 0-.93.5Z"/></svg>';
const PAUSE_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="3" y="2" width="3.4" height="12" rx=".6"/><rect x="9.6" y="2" width="3.4" height="12" rx=".6"/></svg>';
const MUTE_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M1 6h2.8L8 3v10L3.8 10H1z"/><path d="M10.2 5.2 13.8 8.8M13.8 5.2l-3.6 3.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none"/></svg>';
const UNMUTE_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M1 6h2.8L8 3v10L3.8 10H1z"/><path d="M10.4 5.4a3.6 3.6 0 0 1 0 5.2M12.2 3.6a6.2 6.2 0 0 1 0 8.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/></svg>';

/**
 * Build the SDK-drawn transport as a PARTIAL bottom bar, `data-inline3d-overlay`, inside
 * `canvas.parentElement`. Never full-tile — see the "one contract" for overlays in
 * docs/authoring-inline-3d.md; a full-bleed transport would be refused on legacy browsers.
 */
function buildTransportBar(container, canvas, video, { keyboard }) {
  ensureStyle();
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

  const bar = document.createElement('div');
  bar.className = 'dxr-player-bar';
  bar.setAttribute('data-inline3d-overlay', '');

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'dxr-player-btn dxr-player-play';
  playBtn.setAttribute('aria-label', 'Play');
  playBtn.innerHTML = PLAY_ICON;

  const time = document.createElement('span');
  time.className = 'dxr-player-time';
  time.setAttribute('aria-hidden', 'true');
  time.textContent = '0:00';

  const seek = document.createElement('input');
  seek.type = 'range';
  seek.className = 'dxr-player-seek';
  seek.min = '0';
  seek.max = '0';
  seek.step = '0.1';
  seek.value = '0';
  seek.setAttribute('aria-label', 'Seek');

  const dur = document.createElement('span');
  dur.className = 'dxr-player-dur';
  dur.setAttribute('aria-hidden', 'true');
  dur.textContent = '0:00';

  const muteBtn = document.createElement('button');
  muteBtn.type = 'button';
  muteBtn.className = 'dxr-player-btn dxr-player-mute';
  muteBtn.setAttribute('aria-label', video.muted ? 'Unmute' : 'Mute');
  muteBtn.innerHTML = video.muted ? MUTE_ICON : UNMUTE_ICON;

  bar.append(playBtn, time, seek, dur, muteBtn);
  if (canvas.nextSibling) container.insertBefore(bar, canvas.nextSibling);
  else container.appendChild(bar);

  // Focusable so keyboard control works without first clicking a button (see onKeydown below).
  if (!canvas.hasAttribute('tabindex')) canvas.tabIndex = 0;

  let scrubbing = false;

  function syncPlayIcon() {
    const playing = !video.paused && !video.ended;
    playBtn.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }
  function syncMuteIcon() {
    muteBtn.innerHTML = video.muted ? MUTE_ICON : UNMUTE_ICON;
    muteBtn.setAttribute('aria-label', video.muted ? 'Unmute' : 'Mute');
  }
  function syncDuration() {
    if (Number.isFinite(video.duration)) {
      seek.max = String(video.duration);
      dur.textContent = formatTime(video.duration);
    }
  }
  function syncTime() {
    if (!scrubbing) seek.value = String(video.currentTime || 0);
    time.textContent = formatTime(video.currentTime);
    seek.setAttribute('aria-valuetext', formatTime(video.currentTime));
  }

  playBtn.addEventListener('click', () => {
    if (video.paused || video.ended) video.play().catch(() => {});
    else video.pause();
  });
  muteBtn.addEventListener('click', () => {
    video.muted = !video.muted;
    syncMuteIcon();
  });
  seek.addEventListener('pointerdown', () => {
    scrubbing = true;
  });
  seek.addEventListener('input', () => {
    video.currentTime = Number(seek.value) || 0;
  });
  seek.addEventListener('change', () => {
    scrubbing = false;
  });
  seek.addEventListener('blur', () => {
    scrubbing = false;
  });

  video.addEventListener('play', syncPlayIcon);
  video.addEventListener('pause', syncPlayIcon);
  video.addEventListener('ended', syncPlayIcon);
  video.addEventListener('volumechange', syncMuteIcon);
  video.addEventListener('loadedmetadata', syncDuration);
  video.addEventListener('durationchange', syncDuration);
  video.addEventListener('timeupdate', syncTime);

  // Hidden after 3 s of no pointer movement while playing; shown on hover/keypress/pause.
  let hideTimer = 0;
  function show() {
    bar.classList.remove('dxr-player-bar--hidden');
    clearTimeout(hideTimer);
    if (!video.paused && !video.ended) arm();
  }
  function arm() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => bar.classList.add('dxr-player-bar--hidden'), 3000);
  }
  container.addEventListener('pointermove', show);
  container.addEventListener('pointerenter', show);
  container.addEventListener('focusin', show);
  video.addEventListener('pause', show);
  video.addEventListener('play', arm);

  function onKeydown(e) {
    if (!keyboard) return;
    const action = mapKeyToAction(e.key);
    if (!action) return;
    e.preventDefault();
    show();
    switch (action) {
      case 'toggle':
        if (video.paused || video.ended) video.play().catch(() => {});
        else video.pause();
        break;
      case 'seek-5':
        video.currentTime = Math.max(0, video.currentTime - 5);
        break;
      case 'seek+5':
        video.currentTime = video.currentTime + 5;
        break;
      case 'seek-10':
        video.currentTime = Math.max(0, video.currentTime - 10);
        break;
      case 'seek+10':
        video.currentTime = video.currentTime + 10;
        break;
      case 'mute':
        video.muted = !video.muted;
        syncMuteIcon();
        break;
    }
  }
  container.addEventListener('keydown', onKeydown);

  syncPlayIcon();
  syncMuteIcon();
  syncDuration();
  syncTime();

  return {
    el: bar,
    cleanup() {
      clearTimeout(hideTimer);
      container.removeEventListener('pointermove', show);
      container.removeEventListener('pointerenter', show);
      container.removeEventListener('focusin', show);
      container.removeEventListener('keydown', onKeydown);
      bar.remove();
    },
  };
}

// ── addPlayer ────────────────────────────────────────────────────────────────────────────────

/**
 * Load a media title into an inline-3D window with real transport, in one call. Safe with an
 * unsupported/absent `wall` — it renders flat 2D instead (see the module doc comment), so pages
 * need no branch.
 *
 * @param {object|null|undefined} wall  the manager from `createInline3D()`, or null/unsupported.
 * @param {HTMLCanvasElement} canvas  a 2D canvas ALREADY inside a container element — the SDK
 *        transport is a sibling of the canvas, inside `canvas.parentElement` (required for
 *        `controls:'sdk'`, and for the box the transport is anchored to).
 * @param {string|Blob} src  the video URL (or a Blob/File, given an object URL).
 * @param {object} [opts]
 * @param {'sbs'|'mono'} [opts.format='sbs']  `'sbs'` is a real stereo pair, woven via
 *        `wall.addVideo()`. `'mono'` is genuinely flat content, painted full-frame — see the
 *        module doc comment for why this is NOT the same code path as an unsupported browser.
 * @param {string} [opts.poster]  painted before the first frame, and again on `error`.
 * @param {boolean} [opts.autoplay=false]
 * @param {boolean} [opts.muted=true]  autoplay needs this; unmute from the transport or `M`.
 * @param {boolean} [opts.loop=false]
 * @param {'sdk'|'none'} [opts.controls='sdk']  `'none'` leaves chrome to the page (handle +
 *        events + its own `data-inline3d-overlay` elements).
 * @param {boolean} [opts.keyboard=true]  Space/K play-pause, ←/→ ±5s, J/L ±10s, M mute — bound
 *        to the canvas/its controls, not `document`, so multiple players don't fight.
 * @param {number} [opts.fadeMs]  ACCEPTED, NOT IMPLEMENTED in v1 — see setSource() below.
 * @param {'anonymous'|'use-credentials'} [opts.crossOrigin]  default: `'anonymous'` iff `src` is
 *        a cross-origin URL, unset otherwise.
 * @param {number} [opts.width] [opts.height] [opts.cornerRadius] [opts.feather]  forwarded to
 *        `wall.addVideo()` on the `'sbs'` + supported-wall path only (TileOptions).
 * @param {Element} [opts.observe]  forwarded to `wall.addVideo()` (lazy visibility gate).
 * @returns {object} a PlayerHandle — see player.d.ts.
 */
export function addPlayer(wall, canvas, src, opts = {}) {
  const o = normalizePlayerOptions(opts);
  const container = canvas.parentElement;

  const video = document.createElement('video');
  video.playsInline = true;
  video.preload = 'metadata';
  video.muted = o.muted;
  video.loop = o.loop;
  const cross = resolveCrossOrigin(src, o.crossOrigin);
  if (cross) video.crossOrigin = cross;

  const listeners = new Map();
  function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event)?.delete(fn);
  }
  function off(event, fn) {
    listeners.get(event)?.delete(fn);
  }
  function emit(event, payload) {
    for (const fn of listeners.get(event) || []) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[inline3d/player] listener for "${event}" threw`, err);
      }
    }
  }

  video.addEventListener('play', () => emit('play'));
  video.addEventListener('pause', () => emit('pause'));
  video.addEventListener('ended', () => emit('ended'));
  video.addEventListener('timeupdate', () => emit('timeupdate'));
  video.addEventListener('loadedmetadata', () => emit('ready'));
  video.addEventListener('error', () => {
    emit('error', video.error);
    paintPosterNow();
  });

  let posterImg = null;
  function loadPoster(url) {
    if (!url) {
      posterImg = null;
      return;
    }
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      posterImg = img;
      paintPosterNow();
    };
    img.onerror = () => {
      posterImg = null;
    };
    img.src = url;
  }

  const wantWeave = o.format === 'sbs' && !!(wall && wall.supported);
  let innerHandle = null;
  let ownLoop = null;

  function paintPosterNow() {
    if (!posterImg) return;
    if (wantWeave) paintPosterSBS(canvas, posterImg);
    else ownLoop?.forceRepaint();
  }

  if (wantWeave) {
    innerHandle = wall.addVideo(canvas, video, {
      width: o.width,
      height: o.height,
      cornerRadius: o.cornerRadius,
      feather: o.feather,
      ...(o.observe ? { observe: o.observe } : {}),
    });
    startPosterPoll(canvas, () => posterImg, () => video.readyState >= 2);
  } else {
    ownLoop = attachFlatPaint(canvas, video, {
      mode: o.format === 'mono' ? 'mono' : 'sbs-fallback',
      getPoster: () => posterImg,
    });
  }

  loadPoster(o.poster);
  video.src = resolveSrcUrl(src);
  video.load();
  if (o.autoplay) video.play().catch(() => {});

  let bar = null;
  let cleanupBar = null;
  if (o.controls === 'sdk') {
    if (container) {
      const built = buildTransportBar(container, canvas, video, { keyboard: o.keyboard });
      bar = built.el;
      cleanupBar = built.cleanup;
    } else {
      console.warn(
        '[inline3d/player] controls:"sdk" needs canvas.parentElement to attach the transport ' +
          '(the overlay must be a sibling of the canvas) — skipping SDK chrome for this player.'
      );
    }
  }

  const handle = {
    get video() {
      return video;
    },
    play() {
      return video.play();
    },
    pause() {
      video.pause();
    },
    seek(t) {
      const max = Number.isFinite(video.duration) ? video.duration : Math.max(t, 0);
      video.currentTime = Math.max(0, Math.min(t, max));
    },
    get currentTime() {
      return video.currentTime;
    },
    set currentTime(t) {
      video.currentTime = t;
    },
    get duration() {
      return video.duration;
    },
    get paused() {
      return video.paused;
    },
    get ended() {
      return video.ended;
    },
    get volume() {
      return video.volume;
    },
    set volume(v) {
      video.volume = v;
    },
    get muted() {
      return video.muted;
    },
    set muted(m) {
      video.muted = m;
    },
    /**
     * Swap the source in place. `fadeMs` is ACCEPTED and IGNORED in v1: a cheap cross-fade would
     * need a second decoded stream composited alongside the first (two hidden <video>s blended
     * per frame on the woven path, or on the canvas for the flat path) — real engineering, not
     * "wire it and document it" — so it is left for a v2 pass. See docs/authoring-inline-3d.md.
     */
    setSource(newSrc, sOpts = {}) {
      video.pause();
      if (sOpts.poster !== undefined) loadPoster(sOpts.poster);
      const nextCross = resolveCrossOrigin(newSrc, o.crossOrigin);
      if (nextCross) video.crossOrigin = nextCross;
      video.src = resolveSrcUrl(newSrc);
      video.load();
      if (o.autoplay) video.play().catch(() => {});
    },
    exclude(el) {
      innerHandle?.exclude(el);
    },
    unexclude(el) {
      innerHandle?.unexclude(el);
    },
    remove() {
      ownLoop?.stop();
      cleanupBar?.();
      innerHandle?.remove();
      try {
        video.pause();
      } catch {
        /* ignore */
      }
      video.removeAttribute('src');
      video.load();
      listeners.clear();
    },
    on,
    off,
  };

  return handle;
}

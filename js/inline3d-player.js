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
const VALID_SKINS = new Set(['classic', 'dock']);
const VALID_SIZES = new Set(['s', 'm', 'l']);
// ./splat setVideo's `fit` values, same names and meaning (inline3d-splat-video.js VIDEO_FITS).
const VALID_FITS = new Set(['contain', 'cover']);
// What each size multiplies the transport by. Applied with CSS `zoom` on each overlay's CONTENT
// (never the overlay boxes' own positioning), so every icon, font and hit target scales together.
/**
 * Named accents: `accent: 'sunset'` or any CSS colour. Each is light enough that the dock's dark
 * play glyph (#07111d) stays legible on it, and saturated enough to read as the brand colour on a
 * black tile.
 */
export const PLAYER_ACCENTS = Object.freeze({
  azure: '#4da3ff',
  violet: '#9b7bff',
  magenta: '#ff4fa3',
  sunset: '#ff7a45',
  amber: '#ffc23d',
  lime: '#9be15d',
  mint: '#35e0b0',
  ice: '#8fe3ff',
});
/** A named accent to its colour; anything else is passed through as a CSS colour. */
export const resolveAccent = (a) => (typeof a === 'string' && PLAYER_ACCENTS[a.toLowerCase()]) || a;
export const PLAYER_SIZE_SCALE = Object.freeze({ s: 0.84, m: 1, l: 1.28 });
const VALID_CONTROLS = new Set(['sdk', 'none']);

function pickEnum(value, allowed, fallback, label) {
  if (value === undefined) return fallback;
  if (allowed.has(value)) return value;
  console.warn(`[inline3d/player] invalid ${label} "${value}" — using "${fallback}"`);
  return fallback;
}

// ── setSource transitions: the splat module's vocabulary, the subset a video can mean ───────────
//
// `./splat` (1.10-1.17) settled the house spelling: `transition`, `durationMs`, `easing`,
// `outgoing`, with `fadeMs` as the legacy alias for a crossfade. The player takes the same names
// so a page that swaps splats and videos writes one options object. What it takes of them is
// what a flat SBS frame can mean: a CUT and a CROSSFADE. `flip`, `wavefront`, the particle and
// sequence transitions all move or re-light a 3D photo's gaussians; a video frame has none, so
// they are refused BY NAME rather than silently turned into a crossfade.
//
// `outgoing` is 'frozen' only. The dissolve runs from the outgoing title's LAST frame (one
// <video>, see the dissolve section), which is the splat module's 'frozen'. The splat docs warn
// that frozen "reads as tracking pausing" on a tracked panel — true of a splat, which re-renders
// per head pose, and not of an SBS video, whose disparity is baked into the frame either way.
// 'live' would need two decoding <video>s; refused rather than pretended.

/** Named easings — the same names and curves as `./splat` (inline3d-splat-effects.js EASINGS). */
export const PLAYER_EASINGS = Object.freeze({
  linear: (x) => x,
  easeInQuad: (x) => x * x,
  easeOutQuad: (x) => 1 - (1 - x) * (1 - x),
  easeInOutQuad: (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2),
  easeInCubic: (x) => x * x * x,
  easeOutCubic: (x) => 1 - Math.pow(1 - x, 3),
  easeInOutCubic: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  easeInOutSine: (x) => -(Math.cos(Math.PI * x) - 1) / 2,
});
const PLAYER_TRANSITIONS = ['cut', 'crossfade'];
/** `./splat`'s other transitions — named in the refusal so the page knows it was not a typo. */
const SPLAT_ONLY_TRANSITIONS = ['flip', 'wavefront', 'reassemble', 'swarm', 'burst', 'shimmer-cross', 'dust', 'sequence'];
export const DEFAULT_CROSSFADE_MS = 600;
const DEFAULT_TRANSITION_EASING = 'easeInOutSine';

/**
 * Resolve setSource transition options into `{ type, durationMs, easing, ease }`. Pure.
 *
 * `base` is what construction resolved: a per-call option overrides it field by field, so
 * `setSource(src, { durationMs: 1200 })` lengthens the player's crossfade without restating it.
 * Precedence for the duration: `durationMs`, then the legacy `fadeMs`, then `base`, then 600 ms.
 * A bare `fadeMs > 0` still means a crossfade and `fadeMs: 0` a cut, exactly as in 1.10.
 *
 * @param {object} [opts]
 * @param {object} [base]
 */
export function resolveTransition(opts = {}, base = null) {
  const t = opts.transition;
  if (t !== undefined && (typeof t !== 'string' || !PLAYER_TRANSITIONS.includes(t))) {
    const name = typeof t === 'string' ? t : t && typeof t === 'object' ? t.type || 'object' : String(t);
    const splatOnly = typeof t === 'object' || SPLAT_ONLY_TRANSITIONS.includes(name);
    throw new Error(
      `@displayxr/inline3d/player: transition '${name}' is not a player transition` +
        (splatOnly ? " — it is one of ./splat's, which move a 3D photo's gaussians; a video frame has none." : '.') +
        ` Known: ${PLAYER_TRANSITIONS.join(', ')}.`
    );
  }
  if (opts.outgoing !== undefined && opts.outgoing !== 'frozen') {
    throw new Error(
      `@displayxr/inline3d/player: outgoing '${opts.outgoing}' is not supported — the player dissolves ` +
        "from the outgoing title's last frame ('frozen'), with one <video>."
    );
  }
  const e = opts.easing;
  if (e !== undefined && typeof e !== 'function' && !PLAYER_EASINGS[e]) {
    throw new Error(
      `@displayxr/inline3d/player: unknown easing '${e}'. Known: ${Object.keys(PLAYER_EASINGS).join(', ')}, or a function.`
    );
  }
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : undefined);
  const fade = num(opts.fadeMs);
  const dur = num(opts.durationMs);
  let type = t || (fade !== undefined ? (fade > 0 ? 'crossfade' : 'cut') : base ? base.type : 'cut');
  const baseDur = base && base.durationMs > 0 ? base.durationMs : DEFAULT_CROSSFADE_MS;
  const durationMs = dur !== undefined ? dur : fade > 0 ? fade : baseDur;
  // A crossfade of no length IS a cut; say so in the result rather than run a zero-length ramp.
  if (type === 'crossfade' && durationMs <= 0) type = 'cut';
  const easing = e !== undefined ? e : base ? base.easing : DEFAULT_TRANSITION_EASING;
  const ease = typeof easing === 'function' ? easing : PLAYER_EASINGS[easing];
  return { type, durationMs: type === 'cut' ? 0 : durationMs, easing, ease };
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
    // The transport's look. 'classic': a full-width bottom band. 'dock': a floating rounded dock
    // with lit round buttons. Same controls, same overlay rules, CSS only.
    skin: pickEnum(opts.skin, VALID_SKINS, 'classic', 'skin'),
    // Transport scale: 's' | 'm' | 'l' (see PLAYER_SIZE_SCALE).
    size: pickEnum(typeof opts.size === 'string' ? opts.size.toLowerCase() : opts.size, VALID_SIZES, 'm', 'size'),
    // How an eye image meets a tile of a different aspect — ./splat setVideo's vocabulary.
    // 'contain': the whole eye image, transparent bars where the aspects differ (the page shows
    // through). 'cover': the tile is full and the overflow is cut. Unset (null): stretched to the
    // tile, the 1.x behaviour, so a page that never asks keeps its pixels.
    fit: opts.fit === undefined || opts.fit === null ? null : pickEnum(opts.fit, VALID_FITS, null, 'fit'),
    poster: opts.poster || null,
    autoplay: !!opts.autoplay,
    muted: opts.muted === undefined ? true : !!opts.muted,
    loop: !!opts.loop,
    keyboard: opts.keyboard === undefined ? true : !!opts.keyboard,
    fadeMs: typeof opts.fadeMs === 'number' && opts.fadeMs > 0 ? opts.fadeMs : 0,
    // The resolved setSource transition (see resolveTransition). `fadeMs` above stays for 1.10
    // callers reading it back; this is what the player actually runs.
    transition: resolveTransition(opts),
    // Chrome skin. `accent` is written to the transport's `--dxr-accent` custom property, so a
    // page brands the player without forking its CSS; anything CSS accepts as a colour works.
    accent: typeof opts.accent === 'string' && opts.accent ? opts.accent : null,
    // A small "3D" pill in the control row. Opt-in, and the PAGE decides — the module will not
    // infer it from `wall.supported`, because a supported wall whose tile is scrolled away, or
    // whose panel sits in a 2D mode, is not showing 3D at that moment and the badge would lie.
    badge3d: opts.badge3d === undefined ? false : opts.badge3d,
    // A now-playing line over the top of the tile, fading with the transport. Page-supplied text
    // (a catalogue knows the title; the file name is not one).
    title: typeof opts.title === 'string' && opts.title ? opts.title : null,
    // -10 s / +10 s buttons beside play (J / L on the keyboard either way).
    skipButtons: opts.skipButtons === undefined ? true : !!opts.skipButtons,
    // A fullscreen button (and F). The CONTAINER goes fullscreen, not the canvas, so the
    // transport — its sibling overlays — comes along.
    fullscreen: opts.fullscreen === undefined ? true : !!opts.fullscreen,
    crossOrigin: opts.crossOrigin,
    width: opts.width,
    height: opts.height,
    cornerRadius: opts.cornerRadius,
    feather: opts.feather,
    observe: opts.observe,
  };
}

/**
 * The source and destination rects that fit a `sw`×`sh` image into a `dw`×`dh` box. Pure.
 * `'contain'` letterboxes the destination (the whole source shows); `'cover'` crops the source
 * (the whole box fills); anything else stretches. Returns `{ sx, sy, sw, sh, dx, dy, dw, dh }`
 * in the same order `drawImage`'s 9-argument form takes them.
 * @param {number} sw @param {number} sh @param {number} dw @param {number} dh
 * @param {'contain'|'cover'|null} fit
 */
export function fitRect(sw, sh, dw, dh, fit) {
  const full = { sx: 0, sy: 0, sw, sh, dx: 0, dy: 0, dw, dh };
  if (!(sw > 0 && sh > 0 && dw > 0 && dh > 0) || (fit !== 'contain' && fit !== 'cover')) return full;
  const sa = sw / sh;
  const da = dw / dh;
  if (Math.abs(sa - da) < 1e-6) return full;
  if (fit === 'contain') {
    if (sa > da) {
      const h = dw / sa;
      return { sx: 0, sy: 0, sw, sh, dx: 0, dy: (dh - h) / 2, dw, dh: h };
    }
    const w = dh * sa;
    return { sx: 0, sy: 0, sw, sh, dx: (dw - w) / 2, dy: 0, dw: w, dh };
  }
  if (sa > da) {
    const w = sh * da;
    return { sx: (sw - w) / 2, sy: 0, sw: w, sh, dx: 0, dy: 0, dw, dh };
  }
  const h = sw / da;
  return { sx: 0, sy: (sh - h) / 2, sw, sh: h, dx: 0, dy: 0, dw, dh };
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
    case 'f':
    case 'F':
      return 'fullscreen';
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
 * Paint the poster into a LIVE, woven SBS window until the video has a real frame to show.
 *
 * Runs until the FIRST FRAME, not until a timer expires. The earlier version gave up after
 * ~3 s of rAF, which is the wrong shape twice over: `preload:'metadata'` + no autoplay is the
 * default here, so a title that is never played never reaches `readyState >= 2` at all and the
 * tile went black the moment the timer ran out; and a lazy tile that is still 0×0 at 3 s (it
 * hasn't scrolled into view yet) had nothing painted into it by the time it activated.
 *
 * It is a 4 Hz `setTimeout`, not rAF, and that is deliberate: the SDK's own paint re-commits
 * whatever the canvas already holds while a video is below `readyState 2`
 * (`_recommitLastFrame`), so the poster only has to be (re)committed when the buffer is
 * resized or replaced — 60 Hz would buy nothing and cost a full-resolution SBS draw per frame
 * on a tile that is, by definition, showing a still.
 */
function startPosterPoll(canvas, getPoster, isVideoReady) {
  let timer = 0;
  let stopped = false;
  function tick() {
    if (stopped || isVideoReady()) return;
    const img = getPoster();
    if (img) paintPosterSBS(canvas, img);
    timer = setTimeout(tick, 250);
  }
  tick();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

/**
 * The paint loop this module owns for `format:'mono'`, and for `format:'sbs'` on an
 * absent/unsupported wall (see the module doc comment for why). Sizes the canvas to its CSS
 * box × devicePixelRatio (capped at 2, the same convention `addImage`/`addVideo` use), redraws
 * on box changes, and — once the video is decoding — paints only on a NEW frame via
 * `requestVideoFrameCallback` where available, falling back to an every-frame `drawImage` loop
 * where it is not.
 */
function attachFlatPaint(canvas, video, { mode, getPoster, dissolve, fit = null }) {
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

  const nowMs = () =>
    typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

  function draw() {
    if (stopped) return;
    const w = canvas.width;
    const h = canvas.height;
    if (!w || !h) return;
    // With a dissolve armed the mixer is the source of truth: it holds either the live frame,
    // the frozen outgoing one, or the blend of the two. Its dimensions match the video's, so
    // the SBS half-crop below is the same arithmetic either way.
    if (dissolve) dissolve.paint(nowMs());
    const src = dissolve ? dissolve.el : video;
    const ready = (src.readyState || 0) >= 2 && (src.videoWidth || src.width);
    if (ready) {
      const vw = src.videoWidth || src.width;
      const vh = src.videoHeight || src.height;
      ctx.clearRect(0, 0, w, h);
      // One eye (the left half) for an SBS source shown flat, the whole frame for genuinely flat
      // content — then fitted into the canvas the way `fit` asks.
      const ew = mode === 'sbs-fallback' ? vw / 2 : vw;
      const r = fitRect(ew, vh, w, h, fit);
      ctx.drawImage(src, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh);
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
    // A running dissolve advances on frames the video does not produce, so it needs rAF.
    if (!dissolve?.active && video.readyState >= 2 &&
        typeof video.requestVideoFrameCallback === 'function') {
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
//
// THREE HARD CONSTRAINTS shape everything below; they are the overlay contract from
// docs/authoring-inline-3d.md § "2D overlays ON a 3D window", not taste:
//
//  1. EVERY overlay is a PARTIAL region of the tile, never the whole thing. A legacy
//     (pre-draw-order-occlusion) browser excludes an overlay by geometrically matching its rect
//     to a composited quad at >=70% area overlap — a full-tile plate matches the CANVAS's own
//     quad, so the canvas leaves the weave input and the tile presents its raw side-by-side
//     pair: two squished halves, no 3D. That is why the "scrim" here is a bottom band with a
//     capped height, and NOT the full-height gradient a 2D player would reach for. Same reason
//     the centre badge is a small circle rather than a full-tile click-catcher.
//  2. NO `backdrop-filter`, anywhere. Exclusion needs the element as an isolated composited
//     resource; `backdrop-filter` is defined as a function of what is behind it, so there is
//     nothing to hand the compositor and the element either weaves anyway or drops out. The
//     near-solid background below is the documented substitute for frosted glass.
//  3. Promotion is `will-change: transform`, never a CSS `filter` — a filter's render surface is
//     flattened away in the weave path.
//
// Everything visual is driven off CSS custom properties (`--dxr-accent`, `--dxr-p`, `--dxr-b`)
// so the per-frame work is two property writes, not a rebuilt gradient string, and so a page can
// re-skin the transport without forking it.

let styleInjected = false;
const PLAYER_STYLE_ID = 'dxr-player-style';
const PLAYER_CSS = `
/* The tokens live on the HOST, not on the bar: the centre badge, the key pip and the spinner are
   SIBLINGS of the bar (each has to be its own partial overlay — constraint 1), so tokens declared
   on the bar would not reach them and they would render with an invalid background/accent. */
.dxr-player-host{--dxr-accent:#4da3ff;--dxr-ink:#fff;--dxr-shell:rgba(10,11,15,.92);}
.dxr-player{position:absolute;left:0;right:0;bottom:0;z-index:2;box-sizing:border-box;
  padding:34px 12px 10px 12px;color:var(--dxr-ink);
  font:13px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  /* A BOUNDED bottom band — see constraint 1. The gradient fades out well before the top of the
     tile, so the excluded rect stays a partial region at any tile height.
     The ramp is front-loaded on purpose: the scrub row sits at the TOP of this band, and a
     gentle linear fade leaves it sitting on near-transparent pixels — over bright or captioned
     content (this sample's clip has burned-in credits exactly there) the track and the knob
     stop being readable. Most of the darkening is therefore spent in the first 60%, and only
     the last third is allowed to go sheer. */
  background:linear-gradient(to top,rgba(8,9,12,.96) 0%,rgba(8,9,12,.92) 30%,
    rgba(8,9,12,.80) 52%,rgba(8,9,12,.55) 70%,rgba(8,9,12,.22) 87%,rgba(8,9,12,0) 100%);
  max-height:42%;
  text-shadow:0 1px 2px rgba(0,0,0,.55);
  opacity:1;transform:translateY(0);transition:opacity .22s ease,transform .22s ease;
  will-change:transform;}
.dxr-player--hidden{opacity:0;transform:translateY(8px);pointer-events:none;}
.dxr-player *{box-sizing:border-box;}

/* ── scrub row ── */
.dxr-player-scrubwrap{--dxr-p:0%;--dxr-b:0%;position:relative;height:16px;margin:0 2px 2px;
  display:flex;align-items:center;cursor:pointer;touch-action:none;}
.dxr-player-scrubwrap::before{content:"";position:absolute;left:0;right:0;height:4px;
  border-radius:99px;background:
    linear-gradient(to right,rgba(255,255,255,.34) 0 var(--dxr-b),transparent var(--dxr-b)),
    rgba(255,255,255,.18);
  transition:height .14s ease;}
.dxr-player-scrubwrap::after{content:"";position:absolute;left:0;height:4px;width:var(--dxr-p);
  border-radius:99px;background:var(--dxr-accent);transition:height .14s ease;}
.dxr-player-scrubwrap:hover::before,.dxr-player-scrubwrap--active::before,
.dxr-player-scrubwrap:focus-within::before{height:6px;}
.dxr-player-scrubwrap:hover::after,.dxr-player-scrubwrap--active::after,
.dxr-player-scrubwrap:focus-within::after{height:6px;}
/* The real <input type=range> stays in the DOM, transparent, on top: native keyboard handling,
   native AT semantics, native drag — we only take over how it LOOKS. */
.dxr-player-scrub{position:absolute;inset:0;width:100%;height:100%;margin:0;padding:0;
  opacity:0;cursor:pointer;appearance:none;-webkit-appearance:none;background:transparent;}
.dxr-player-scrub::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;
  height:16px;border-radius:50%;background:#000;}
.dxr-player-scrub::-moz-range-thumb{width:16px;height:16px;border:0;border-radius:50%;
  background:#000;}
.dxr-player-knob{position:absolute;left:var(--dxr-p);top:50%;width:13px;height:13px;
  margin-left:-6.5px;margin-top:-6.5px;border-radius:50%;background:var(--dxr-accent);
  box-shadow:0 1px 4px rgba(0,0,0,.55);pointer-events:none;
  transform:scale(0);transition:transform .14s ease;}
.dxr-player-scrubwrap:hover .dxr-player-knob,.dxr-player-scrubwrap--active .dxr-player-knob,
.dxr-player-scrub:focus-visible~.dxr-player-knob{transform:scale(1);}
.dxr-player-scrub:focus-visible~.dxr-player-knob{box-shadow:0 0 0 3px rgba(77,163,255,.45),
  0 1px 4px rgba(0,0,0,.55);}
.dxr-player-tip{position:absolute;bottom:20px;left:var(--dxr-tip,0%);transform:translateX(-50%);
  padding:3px 7px;border-radius:5px;background:var(--dxr-shell);font-variant-numeric:tabular-nums;
  font-size:12px;line-height:1;white-space:nowrap;pointer-events:none;opacity:0;
  transition:opacity .12s ease;}
.dxr-player-scrubwrap:hover .dxr-player-tip,
.dxr-player-scrubwrap--active .dxr-player-tip{opacity:1;}

/* ── control row ── */
.dxr-player-row{display:flex;align-items:center;gap:4px;min-height:32px;}
.dxr-player-btn{appearance:none;-webkit-appearance:none;border:0;background:transparent;
  color:inherit;width:32px;height:32px;padding:6px;border-radius:7px;cursor:pointer;flex:none;
  display:inline-flex;align-items:center;justify-content:center;
  transition:background-color .14s ease,transform .14s ease;}
.dxr-player-btn svg{width:100%;height:100%;fill:currentColor;display:block;}
.dxr-player-btn:hover{background:rgba(255,255,255,.16);}
.dxr-player-btn:active{transform:scale(.92);}
.dxr-player-btn:focus-visible{outline:2px solid var(--dxr-accent);outline-offset:2px;}
.dxr-player-vol{display:flex;align-items:center;flex:none;}
.dxr-player-volslider{width:0;opacity:0;margin:0;height:4px;border-radius:99px;flex:none;
  appearance:none;-webkit-appearance:none;cursor:pointer;
  background:linear-gradient(to right,var(--dxr-accent) 0 var(--dxr-v,100%),
    rgba(255,255,255,.22) var(--dxr-v,100%));
  transition:width .18s ease,opacity .18s ease,margin .18s ease;}
.dxr-player-vol:hover .dxr-player-volslider,.dxr-player-vol:focus-within .dxr-player-volslider,
.dxr-player-volslider:focus-visible{width:62px;opacity:1;margin:0 8px 0 2px;}
.dxr-player-volslider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:11px;
  height:11px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.5);}
.dxr-player-volslider::-moz-range-thumb{width:11px;height:11px;border:0;border-radius:50%;
  background:#fff;}
.dxr-player-volslider:focus-visible{outline:2px solid var(--dxr-accent);outline-offset:3px;}
.dxr-player-clock{margin-left:6px;font-variant-numeric:tabular-nums;letter-spacing:.2px;
  white-space:nowrap;}
.dxr-player-clock b{font-weight:600;}
.dxr-player-clock span{opacity:.62;}
.dxr-player-spacer{flex:1 1 auto;}
.dxr-player-skip{padding:5px;}

/* ── now-playing line: a BOUNDED top band, its own partial overlay (constraint 1) ── */
.dxr-player-title{position:absolute;left:0;right:0;top:0;z-index:2;box-sizing:border-box;
  padding:12px 16px 30px;max-height:30%;overflow:hidden;color:var(--dxr-ink);pointer-events:none;
  font:600 15px/1.3 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;letter-spacing:.1px;
  white-space:nowrap;text-overflow:ellipsis;text-shadow:0 1px 3px rgba(0,0,0,.6);
  background:linear-gradient(to bottom,rgba(8,9,12,.78) 0%,rgba(8,9,12,.5) 55%,rgba(8,9,12,0) 100%);
  opacity:1;transform:translateY(0);transition:opacity .22s ease,transform .22s ease;
  will-change:transform;}
.dxr-player-title--hidden{opacity:0;transform:translateY(-8px);}

/* Fullscreen: the host fills the screen, black; the canvas itself is sized to fit (in JS, at the
   tile's own aspect) — never object-fit, because the weave reads the element's whole rect, so
   letterboxing INSIDE the canvas would put each eye's content where the other eye is sampled. */
.dxr-player-host:fullscreen{background:#000;display:flex;align-items:center;justify-content:center;}
.dxr-player-host:fullscreen>canvas{flex:none;}

.dxr-player-badge3d{font-size:10px;font-weight:700;letter-spacing:.9px;padding:3px 7px;
  border-radius:5px;border:1px solid rgba(255,255,255,.28);opacity:.82;flex:none;}

/* ── centre affordances (small, partial — constraint 1) ── */
.dxr-player-centre{position:absolute;left:50%;top:50%;width:66px;height:66px;margin:-33px 0 0 -33px;
  z-index:2;border:0;border-radius:50%;padding:19px;cursor:pointer;color:#fff;
  background:var(--dxr-shell);box-shadow:0 4px 18px rgba(0,0,0,.45);
  display:inline-flex;align-items:center;justify-content:center;
  transition:opacity .2s ease,transform .2s ease;will-change:transform;}
.dxr-player-centre svg{width:100%;height:100%;fill:currentColor;display:block;}
.dxr-player-centre:hover{transform:scale(1.07);}
.dxr-player-centre:focus-visible{outline:2px solid var(--dxr-accent);outline-offset:3px;}
.dxr-player-centre--hidden{opacity:0;transform:scale(.8);pointer-events:none;}
.dxr-player-pip{position:absolute;left:50%;top:50%;width:60px;height:60px;margin:-30px 0 0 -30px;
  z-index:2;border-radius:50%;padding:16px;color:#fff;background:rgba(10,11,15,.7);
  display:flex;align-items:center;justify-content:center;pointer-events:none;opacity:0;}
.dxr-player-pip svg{width:100%;height:100%;fill:currentColor;display:block;}
.dxr-player-pip--on{animation:dxr-pip .5s ease forwards;}
@keyframes dxr-pip{0%{opacity:0;transform:scale(.72)}22%{opacity:1;transform:scale(1)}
  100%{opacity:0;transform:scale(1.25)}}
.dxr-player-spin{position:absolute;left:50%;top:50%;width:40px;height:40px;margin:-20px 0 0 -20px;
  z-index:2;border-radius:50%;border:3px solid rgba(255,255,255,.22);
  border-top-color:var(--dxr-accent);pointer-events:none;opacity:0;
  transition:opacity .18s ease;}
.dxr-player-spin--on{opacity:1;animation:dxr-spin .9s linear infinite;}
@keyframes dxr-spin{to{transform:rotate(360deg)}}

.dxr-player-host--idle{cursor:none;}
/* ── skin: 'dock' ──────────────────────────────────────────────────────────────────────────────
   Every glow stays INSIDE its element's own box. An overlay is excluded from the weave by its
   rect; a shadow painted outside that rect is page content OVER the woven canvas, so it would be
   woven with it — a soft double-imaged smudge around the dock. Hence: no outer box-shadow on the
   dock, and the buttons' halos are inset or sit within the dock's padding. */
.dxr-player-host--dock{--dxr-accent-hi:color-mix(in srgb,var(--dxr-accent) 62%,#fff);
  --dxr-accent-lo:color-mix(in srgb,var(--dxr-accent) 72%,#000);}
.dxr-player-host--dock .dxr-player{left:12px;right:12px;bottom:12px;padding:10px 12px 8px;
  border-radius:18px;max-height:none;text-shadow:none;
  background:linear-gradient(180deg,rgba(44,48,62,.95) 0%,rgba(20,22,30,.96) 55%,rgba(12,13,18,.97) 100%);
  border:1px solid rgba(255,255,255,.09);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.10),inset 0 -1px 0 rgba(0,0,0,.4);}
.dxr-player-host--dock .dxr-player--hidden{transform:translateY(10px) scale(.985);}
.dxr-player-host--dock .dxr-player-row{gap:6px;min-height:40px;}
.dxr-player-host--dock .dxr-player-btn{width:34px;height:34px;padding:7px;border-radius:50%;
  background:radial-gradient(circle at 32% 26%,rgba(255,255,255,.22),rgba(255,255,255,.05) 58%,rgba(255,255,255,.02));
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.12),inset 0 1px 0 rgba(255,255,255,.18),
    inset 0 -2px 4px rgba(0,0,0,.35);
  transition:box-shadow .16s ease,transform .12s ease,background .16s ease,color .16s ease;}
.dxr-player-host--dock .dxr-player-btn:hover{background:radial-gradient(circle at 32% 26%,
    rgba(255,255,255,.30),rgba(255,255,255,.08) 58%,rgba(255,255,255,.03));
  box-shadow:inset 0 0 0 1.5px var(--dxr-accent),inset 0 0 10px color-mix(in srgb,var(--dxr-accent) 45%,transparent),
    inset 0 1px 0 rgba(255,255,255,.2);color:#fff;}
.dxr-player-host--dock .dxr-player-btn:active{transform:scale(.9);}
.dxr-player-host--dock .dxr-player-skip{padding:6px;}
/* The primary: a lit accent orb. */
.dxr-player-host--dock .dxr-player-play{width:42px;height:42px;padding:10px;color:#07111d;
  background:radial-gradient(circle at 34% 26%,var(--dxr-accent-hi),var(--dxr-accent) 55%,var(--dxr-accent-lo));
  box-shadow:inset 0 1px 1px rgba(255,255,255,.55),inset 0 -3px 6px rgba(0,0,0,.28),
    inset 0 0 0 1px rgba(255,255,255,.18);}
.dxr-player-host--dock .dxr-player-play:hover{color:#07111d;
  background:radial-gradient(circle at 34% 26%,#fff,var(--dxr-accent-hi) 40%,var(--dxr-accent) 85%);
  box-shadow:inset 0 1px 1px rgba(255,255,255,.7),inset 0 -3px 6px rgba(0,0,0,.22),
    inset 0 0 0 1px rgba(255,255,255,.3);}
/* Scrub: a lit fill and a knob with a ring, inside the dock. */
.dxr-player-host--dock .dxr-player-scrubwrap{margin:0 4px 6px;}
.dxr-player-host--dock .dxr-player-scrubwrap::before{height:5px;
  box-shadow:inset 0 1px 2px rgba(0,0,0,.5);}
.dxr-player-host--dock .dxr-player-scrubwrap::after{height:5px;
  background:linear-gradient(90deg,var(--dxr-accent-lo),var(--dxr-accent) 60%,var(--dxr-accent-hi));
  box-shadow:0 0 6px color-mix(in srgb,var(--dxr-accent) 70%,transparent);}
.dxr-player-host--dock .dxr-player-knob{width:15px;height:15px;margin-left:-7.5px;margin-top:-7.5px;
  background:radial-gradient(circle at 35% 30%,#fff,#dfe8f5 60%,#b9c6d8);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--dxr-accent) 55%,transparent),0 1px 3px rgba(0,0,0,.6);}
.dxr-player-host--dock .dxr-player-tip{bottom:22px;border-radius:7px;
  background:linear-gradient(180deg,rgba(52,57,72,.98),rgba(24,26,34,.98));
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.1);}
.dxr-player-host--dock .dxr-player-clock b{color:#fff;}
.dxr-player-host--dock .dxr-player-badge3d{border:0;opacity:1;color:#07111d;
  background:linear-gradient(180deg,var(--dxr-accent-hi),var(--dxr-accent));}
/* Centre: a larger lit orb, ring included in its own box. */
.dxr-player-host--dock .dxr-player-centre{width:78px;height:78px;margin:-39px 0 0 -39px;padding:22px;
  color:#07111d;
  background:radial-gradient(circle at 34% 26%,var(--dxr-accent-hi),var(--dxr-accent) 55%,var(--dxr-accent-lo));
  box-shadow:inset 0 0 0 4px rgba(255,255,255,.14),inset 0 2px 2px rgba(255,255,255,.5),
    inset 0 -5px 10px rgba(0,0,0,.3);}
.dxr-player-host--dock .dxr-player-centre svg{transform:translateX(2px);}
.dxr-player-host--dock .dxr-player-title{left:12px;right:12px;top:12px;padding:9px 14px;
  border-radius:14px;max-height:none;width:max-content;max-width:calc(100% - 24px);text-shadow:none;
  background:linear-gradient(180deg,rgba(44,48,62,.92),rgba(16,18,24,.94));
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.08);}
.dxr-player-host--dock .dxr-player-title--hidden{transform:translateY(-10px);}

/* ── size: 's' | 'm' | 'l' — "zoom" on overlay CONTENT only ──────────────────────────────────────
   The bar's row and scrub, and each centre affordance's glyph box, scale as a unit; the overlay
   boxes keep their own anchoring (bottom band / centred), so nothing drifts off-centre. */
.dxr-player-host{--dxr-z:1;}
.dxr-player-host--size-s{--dxr-z:${PLAYER_SIZE_SCALE.s};}
.dxr-player-host--size-l{--dxr-z:${PLAYER_SIZE_SCALE.l};}
.dxr-player-row,.dxr-player-scrubwrap,.dxr-player-title{zoom:var(--dxr-z);}
.dxr-player-centre,.dxr-player-pip,.dxr-player-spin{zoom:var(--dxr-z);}

/* ── anti-aliased round edges ─────────────────────────────────────────────────────────────────
   An overlay is re-composited on its own; there the rounded CLIP of a border-radius edge can come
   out stair-stepped. So the round controls draw their edge themselves: a mask that feathers the
   last ~1.5 px to transparent. The edge is then in the element's own pixels, AA however it is
   composited. (A mask is not a backdrop effect — it depends on nothing behind the element.) */
.dxr-player-host--dock .dxr-player-btn,.dxr-player-host--dock .dxr-player-centre,
.dxr-player-centre,.dxr-player-pip,.dxr-player-knob{
  -webkit-mask:radial-gradient(circle closest-side,#000 calc(100% - 1.6px),transparent 100%);
  mask:radial-gradient(circle closest-side,#000 calc(100% - 1.6px),transparent 100%);}

@media (prefers-reduced-motion:reduce){
  .dxr-player,.dxr-player-title,.dxr-player-btn,.dxr-player-centre,.dxr-player-knob,.dxr-player-tip,
  .dxr-player-volslider,.dxr-player-scrubwrap::before,.dxr-player-scrubwrap::after,
  .dxr-player-spin{transition:none!important;}
  .dxr-player-pip--on{animation-duration:.01ms;}
  .dxr-player-spin--on{animation:none;}
}
@media (max-width:420px){
  .dxr-player{padding:20px 8px 8px;}
  .dxr-player-clock{font-size:12px;}
  .dxr-player-skip{display:none;}
  .dxr-player-title{font-size:13px;padding:8px 10px 22px;}
  .dxr-player-vol:hover .dxr-player-volslider{width:44px;}
}
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

const svg = (body) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;

const PLAY_ICON = svg(
  '<path d="M8 5.2v13.6a1 1 0 0 0 1.53.85l10.2-6.8a1 1 0 0 0 0-1.7L9.53 4.35A1 1 0 0 0 8 5.2Z"/>'
);
const PAUSE_ICON = svg(
  '<rect x="6" y="4.2" width="4.2" height="15.6" rx="1.6"/>' +
    '<rect x="13.8" y="4.2" width="4.2" height="15.6" rx="1.6"/>'
);
const REPLAY_ICON = svg(
  '<path d="M12 5V2.6a.5.5 0 0 0-.82-.38L7.3 5.35a.5.5 0 0 0 0 .77l3.88 3.13A.5.5 0 0 0 12 8.87V7a5 5 0 1 1-5 5 1 1 0 1 0-2 0 7 7 0 1 0 7-7Z"/>'
);
// Three volume states, so the button reports level as well as mute — a speaker with no waves at
// volume 0 is a different thing from a muted speaker, and a player that conflates them makes
// "why is there no sound" unanswerable from the chrome.
const VOL_HIGH_ICON = svg(
  '<path d="M4 9.2h3.3L12 5.1a.6.6 0 0 1 1 .46v12.88a.6.6 0 0 1-1 .46L7.3 14.8H4a.8.8 0 0 1-.8-.8v-4a.8.8 0 0 1 .8-.8Z"/>' +
    '<path d="M15.8 9a4 4 0 0 1 0 6M18.3 6.4a7.4 7.4 0 0 1 0 11.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" fill="none"/>'
);
const VOL_LOW_ICON = svg(
  '<path d="M4 9.2h3.3L12 5.1a.6.6 0 0 1 1 .46v12.88a.6.6 0 0 1-1 .46L7.3 14.8H4a.8.8 0 0 1-.8-.8v-4a.8.8 0 0 1 .8-.8Z"/>' +
    '<path d="M15.8 9a4 4 0 0 1 0 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" fill="none"/>'
);
const MUTE_ICON = svg(
  '<path d="M4 9.2h3.3L12 5.1a.6.6 0 0 1 1 .46v12.88a.6.6 0 0 1-1 .46L7.3 14.8H4a.8.8 0 0 1-.8-.8v-4a.8.8 0 0 1 .8-.8Z"/>' +
    '<path d="m16.2 9.4 4.4 4.4M20.6 9.4l-4.4 4.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>'
);
const FWD_ICON = svg(
  '<path d="M12 5V2.6a.5.5 0 0 1 .82-.38l3.88 3.13a.5.5 0 0 1 0 .77l-3.88 3.13A.5.5 0 0 1 12 8.87V7a5 5 0 1 0 5 5 1 1 0 1 1 2 0 7 7 0 1 1-7-7Z"/>'
);
const BACK_ICON = REPLAY_ICON;
const FS_ENTER_ICON = svg(
  '<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'
);
const FS_EXIT_ICON = svg(
  '<path d="M9 4v4a1 1 0 0 1-1 1H4M20 9h-4a1 1 0 0 1-1-1V4M15 20v-4a1 1 0 0 1 1-1h4M4 15h4a1 1 0 0 1 1 1v4" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'
);
// Skip icons: plain rewind / fast-forward glyphs — no seconds label (text inside a 34 px button
// reads as clutter; the aria-label and the ±10 s pip carry the amount).
const skipIcon = (dir) =>
  svg(
    dir < 0
      ? '<path d="M11.2 6.3v11.4a.8.8 0 0 1-1.25.66L2.6 12.66a.8.8 0 0 1 0-1.32l7.35-5.7a.8.8 0 0 1 1.25.66Z"/>' +
        '<path d="M21 6.3v11.4a.8.8 0 0 1-1.25.66l-7.35-5.7a.8.8 0 0 1 0-1.32l7.35-5.7A.8.8 0 0 1 21 6.3Z"/>'
      : '<path d="M12.8 6.3v11.4a.8.8 0 0 0 1.25.66l7.35-5.7a.8.8 0 0 0 0-1.32l-7.35-5.7a.8.8 0 0 0-1.25.66Z"/>' +
        '<path d="M3 6.3v11.4a.8.8 0 0 0 1.25.66l7.35-5.7a.8.8 0 0 0 0-1.32L4.25 5.64A.8.8 0 0 0 3 6.3Z"/>'
  );
const fsElement = () => (typeof document !== 'undefined' ? document.fullscreenElement : null);

function volumeIcon(video) {
  if (video.muted || video.volume === 0) return MUTE_ICON;
  return video.volume < 0.5 ? VOL_LOW_ICON : VOL_HIGH_ICON;
}

const pct = (n) => `${Math.max(0, Math.min(100, n * 100)).toFixed(3)}%`;

/**
 * How much of the source is buffered AHEAD OF the playhead, as a 0..1 fraction of duration.
 * Pure, and exported for the unit tests: it takes the two numbers a `TimeRanges` yields rather
 * than the object, so it can be checked without a `<video>`.
 *
 * Reported as "the end of the range CONTAINING the playhead", not "the end of the last range" —
 * after a seek into an unbuffered region the last range is behind you, and painting it as
 * buffered-ahead is the lie that makes a scrub bar look full while the player stalls.
 *
 * @param {Array<[number, number]>} ranges  [start, end] pairs, in seconds
 * @param {number} currentTime
 * @param {number} duration
 */
export function bufferedFraction(ranges, currentTime, duration) {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  for (const [start, end] of ranges || []) {
    if (currentTime >= start - 0.25 && currentTime <= end) {
      return Math.max(0, Math.min(1, end / duration));
    }
  }
  return 0;
}

function readBuffered(video) {
  const out = [];
  const b = video.buffered;
  if (!b) return out;
  for (let i = 0; i < b.length; i++) {
    try {
      out.push([b.start(i), b.end(i)]);
    } catch {
      /* an index that went away between length and start(): ignore this range */
    }
  }
  return out;
}

/**
 * Build the SDK-drawn transport: a bottom band, a centre play badge, a keyboard-action pip and a
 * buffering spinner — each its own `data-inline3d-overlay`, each a PARTIAL region of the tile
 * (constraint 1 at the top of this section). Returns the bar element and a cleanup.
 */
function buildTransportBar(container, canvas, video, { keyboard, accent, badge3d, title, skipButtons, fullscreen, skin, size }) {
  ensureStyle();
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.classList.add('dxr-player-host');
  /** Skin, size and accent are all host state — one class or one property, inherited by every overlay. */
  function applyAppearance(a) {
    if (a.skin !== undefined) container.classList.toggle('dxr-player-host--dock', a.skin === 'dock');
    if (a.size !== undefined) {
      for (const k of VALID_SIZES) container.classList.toggle(`dxr-player-host--size-${k}`, k === a.size && k !== 'm');
    }
    if (a.accent !== undefined) {
      if (a.accent) container.style.setProperty('--dxr-accent', resolveAccent(a.accent));
      else container.style.removeProperty('--dxr-accent');
    }
  }
  applyAppearance({ skin, size, accent: accent || undefined });

  const bar = document.createElement('div');
  bar.className = 'dxr-player';
  bar.setAttribute('data-inline3d-overlay', '');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Video player controls');

  // ── scrub ──
  const scrubWrap = document.createElement('div');
  scrubWrap.className = 'dxr-player-scrubwrap';

  const seek = document.createElement('input');
  seek.type = 'range';
  seek.className = 'dxr-player-scrub';
  seek.min = '0';
  seek.max = '0';
  seek.step = '0.05';
  seek.value = '0';
  seek.setAttribute('aria-label', 'Seek');

  const knob = document.createElement('div');
  knob.className = 'dxr-player-knob';
  const tip = document.createElement('div');
  tip.className = 'dxr-player-tip';
  tip.textContent = '0:00';
  scrubWrap.append(seek, knob, tip);

  // ── controls ──
  const row = document.createElement('div');
  row.className = 'dxr-player-row';

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'dxr-player-btn dxr-player-play';
  playBtn.setAttribute('aria-label', 'Play');
  playBtn.innerHTML = PLAY_ICON;

  const volGroup = document.createElement('div');
  volGroup.className = 'dxr-player-vol';
  const muteBtn = document.createElement('button');
  muteBtn.type = 'button';
  muteBtn.className = 'dxr-player-btn dxr-player-mute';
  muteBtn.innerHTML = volumeIcon(video);
  muteBtn.setAttribute('aria-label', video.muted ? 'Unmute' : 'Mute');
  const vol = document.createElement('input');
  vol.type = 'range';
  vol.className = 'dxr-player-volslider';
  vol.min = '0';
  vol.max = '1';
  vol.step = '0.01';
  vol.value = String(video.muted ? 0 : video.volume);
  vol.setAttribute('aria-label', 'Volume');
  volGroup.append(muteBtn, vol);

  const clock = document.createElement('div');
  clock.className = 'dxr-player-clock';
  clock.setAttribute('aria-hidden', 'true');
  clock.innerHTML = '<b>0:00</b><span> / 0:00</span>';

  const spacer = document.createElement('div');
  spacer.className = 'dxr-player-spacer';

  function skipBtn(delta) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dxr-player-btn dxr-player-skip';
    b.setAttribute('aria-label', delta < 0 ? `Back ${-delta} seconds` : `Forward ${delta} seconds`);
    b.innerHTML = skipIcon(delta);
    b.addEventListener('click', () => skipBy(delta));
    return b;
  }
  row.append(playBtn);
  if (skipButtons) row.append(skipBtn(-10), skipBtn(10));
  row.append(volGroup, clock, spacer);
  if (badge3d) {
    const badge = document.createElement('span');
    badge.className = 'dxr-player-badge3d';
    badge.textContent = badge3d === true ? '3D' : String(badge3d);
    badge.setAttribute('aria-label', 'Glasses-free 3D');
    row.append(badge);
  }

  let fsBtn = null;
  const canFullscreen = fullscreen && typeof container.requestFullscreen === 'function';
  if (canFullscreen) {
    fsBtn = document.createElement('button');
    fsBtn.type = 'button';
    fsBtn.className = 'dxr-player-btn dxr-player-fs';
    fsBtn.setAttribute('aria-label', 'Full screen');
    fsBtn.innerHTML = FS_ENTER_ICON;
    fsBtn.addEventListener('click', () => toggleFullscreen());
    row.append(fsBtn);
  }

  bar.append(scrubWrap, row);

  // Always created (it is how setSource can add a title later); empty = hidden, no band drawn.
  const titleEl = document.createElement('div');
  titleEl.className = 'dxr-player-title';
  titleEl.setAttribute('data-inline3d-overlay', '');
  function setTitle(t) {
    titleEl.textContent = t || '';
    titleEl.style.display = t ? '' : 'none';
  }
  setTitle(title);

  // ── centre affordances ──
  const centre = document.createElement('button');
  centre.type = 'button';
  centre.className = 'dxr-player-centre';
  centre.setAttribute('data-inline3d-overlay', '');
  centre.setAttribute('aria-label', 'Play');
  centre.innerHTML = PLAY_ICON;

  const pip = document.createElement('div');
  pip.className = 'dxr-player-pip';
  pip.setAttribute('data-inline3d-overlay', '');
  pip.setAttribute('aria-hidden', 'true');

  const spinner = document.createElement('div');
  spinner.className = 'dxr-player-spin';
  spinner.setAttribute('data-inline3d-overlay', '');
  spinner.setAttribute('aria-hidden', 'true');

  const anchor = canvas.nextSibling;
  for (const el of [titleEl, bar, centre, pip, spinner]) {
    if (anchor) container.insertBefore(el, anchor);
    else container.appendChild(el);
  }

  // Focusable so keyboard control works without first clicking a button.
  if (!canvas.hasAttribute('tabindex')) canvas.tabIndex = 0;

  let scrubbing = false;
  let pipTimer = 0;

  function flashPip(icon) {
    pip.innerHTML = icon;
    pip.classList.remove('dxr-player-pip--on');
    void pip.offsetWidth; // restart the animation
    pip.classList.add('dxr-player-pip--on');
    clearTimeout(pipTimer);
    pipTimer = setTimeout(() => pip.classList.remove('dxr-player-pip--on'), 520);
  }

  function syncPlayIcon() {
    const playing = !video.paused && !video.ended;
    playBtn.innerHTML = playing ? PAUSE_ICON : video.ended ? REPLAY_ICON : PLAY_ICON;
    playBtn.setAttribute('aria-label', playing ? 'Pause' : video.ended ? 'Replay' : 'Play');
    centre.innerHTML = video.ended ? REPLAY_ICON : PLAY_ICON;
    centre.setAttribute('aria-label', video.ended ? 'Replay' : 'Play');
    centre.classList.toggle('dxr-player-centre--hidden', playing);
  }
  function syncVolume() {
    muteBtn.innerHTML = volumeIcon(video);
    muteBtn.setAttribute('aria-label', video.muted ? 'Unmute' : 'Mute');
    const level = video.muted ? 0 : video.volume;
    vol.value = String(level);
    vol.style.setProperty('--dxr-v', pct(level));
  }
  function syncDuration() {
    if (Number.isFinite(video.duration) && video.duration > 0) {
      seek.max = String(video.duration);
      clock.querySelector('span').textContent = ` / ${formatTime(video.duration)}`;
    }
  }
  function syncTime() {
    const d = video.duration;
    const t = video.currentTime || 0;
    if (!scrubbing) {
      seek.value = String(t);
      if (Number.isFinite(d) && d > 0) scrubWrap.style.setProperty('--dxr-p', pct(t / d));
    }
    scrubWrap.style.setProperty('--dxr-b', pct(bufferedFraction(readBuffered(video), t, d)));
    clock.querySelector('b').textContent = formatTime(t);
    seek.setAttribute('aria-valuetext', `${formatTime(t)} of ${formatTime(d)}`);
  }
  function togglePlay() {
    if (video.paused || video.ended) video.play().catch(() => {});
    else video.pause();
  }
  function skipBy(delta) {
    const d = video.duration;
    const t = (video.currentTime || 0) + delta;
    video.currentTime = Math.max(0, Number.isFinite(d) ? Math.min(d, t) : t);
    flashPip(skipIcon(delta));
  }
  function toggleFullscreen() {
    if (!canFullscreen) return;
    if (fsElement() === container) document.exitFullscreen?.().catch(() => {});
    else container.requestFullscreen().catch(() => {});
  }
  // The canvas's inline size before fullscreen, restored on the way out; and its aspect, kept.
  let fsSaved = null;
  function fitFullscreen() {
    if (!fsSaved) return;
    const W = container.clientWidth;
    const H = container.clientHeight;
    const w = Math.min(W, H * fsSaved.aspect);
    canvas.style.width = `${Math.round(w)}px`;
    canvas.style.height = `${Math.round(w / fsSaved.aspect)}px`;
  }
  function syncFullscreen() {
    if (!fsBtn) return;
    const on = fsElement() === container;
    if (on && !fsSaved) {
      const r = canvas.getBoundingClientRect();
      fsSaved = { width: canvas.style.width, height: canvas.style.height, aspect: r.height ? r.width / r.height : 16 / 9 };
      fitFullscreen();
      window.addEventListener('resize', fitFullscreen);
    } else if (!on && fsSaved) {
      window.removeEventListener('resize', fitFullscreen);
      canvas.style.width = fsSaved.width;
      canvas.style.height = fsSaved.height;
      fsSaved = null;
    }
    fsBtn.innerHTML = on ? FS_EXIT_ICON : FS_ENTER_ICON;
    fsBtn.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
  }
  if (canFullscreen) document.addEventListener('fullscreenchange', syncFullscreen);

  playBtn.addEventListener('click', togglePlay);
  centre.addEventListener('click', togglePlay);
  muteBtn.addEventListener('click', () => {
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) video.volume = 0.5;
  });
  vol.addEventListener('input', () => {
    const v = Number(vol.value);
    video.volume = v;
    video.muted = v === 0;
  });

  function ratioFromEvent(e) {
    const rect = scrubWrap.getBoundingClientRect();
    if (!rect.width) return 0;
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }
  scrubWrap.addEventListener('pointermove', (e) => {
    const r = ratioFromEvent(e);
    scrubWrap.style.setProperty('--dxr-tip', pct(r));
    if (Number.isFinite(video.duration)) tip.textContent = formatTime(r * video.duration);
  });
  seek.addEventListener('pointerdown', () => {
    scrubbing = true;
    scrubWrap.classList.add('dxr-player-scrubwrap--active');
  });
  seek.addEventListener('input', () => {
    const t = Number(seek.value) || 0;
    video.currentTime = t;
    if (Number.isFinite(video.duration) && video.duration > 0) {
      scrubWrap.style.setProperty('--dxr-p', pct(t / video.duration));
    }
  });
  function endScrub() {
    scrubbing = false;
    scrubWrap.classList.remove('dxr-player-scrubwrap--active');
  }
  seek.addEventListener('change', endScrub);
  seek.addEventListener('pointerup', endScrub);
  seek.addEventListener('pointercancel', endScrub);
  seek.addEventListener('blur', endScrub);

  // The spinner means "playback is stalled waiting for data", which a PAUSED player never is.
  // Gating on that is not cosmetic: `waiting` fires when you seek into an unbuffered region, and
  // if the video is paused there is then no `playing` to follow — only `seeked` — so a spinner
  // cleared solely by `playing`/`canplay` latches on forever behind the centre badge.
  const onWaiting = () => {
    if (!video.paused) spinner.classList.add('dxr-player-spin--on');
  };
  const onPlayingOrStall = () => spinner.classList.remove('dxr-player-spin--on');

  video.addEventListener('play', syncPlayIcon);
  video.addEventListener('pause', syncPlayIcon);
  video.addEventListener('ended', syncPlayIcon);
  video.addEventListener('volumechange', syncVolume);
  video.addEventListener('loadedmetadata', syncDuration);
  video.addEventListener('durationchange', syncDuration);
  video.addEventListener('timeupdate', syncTime);
  video.addEventListener('progress', syncTime);
  video.addEventListener('seeking', syncTime);
  video.addEventListener('waiting', onWaiting);
  video.addEventListener('playing', onPlayingOrStall);
  video.addEventListener('canplay', onPlayingOrStall);
  video.addEventListener('seeked', onPlayingOrStall);
  video.addEventListener('pause', onPlayingOrStall);
  video.addEventListener('ended', onPlayingOrStall);
  video.addEventListener('error', onPlayingOrStall);

  // Auto-hide: 3 s idle while playing. Never while paused, scrubbing, or the pointer is over the
  // chrome itself — a bar that vanishes under the cursor you are aiming with is the classic
  // version of this bug.
  let hideTimer = 0;
  let pointerInChrome = false;
  function show() {
    bar.classList.remove('dxr-player--hidden');
    titleEl.classList.remove('dxr-player-title--hidden');
    container.classList.remove('dxr-player-host--idle');
    clearTimeout(hideTimer);
    if (!video.paused && !video.ended) arm();
  }
  function arm() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (scrubbing || pointerInChrome || video.paused || video.ended) return;
      bar.classList.add('dxr-player--hidden');
      titleEl.classList.add('dxr-player-title--hidden');
      container.classList.add('dxr-player-host--idle');
    }, 3000);
  }
  const onChromeEnter = () => {
    pointerInChrome = true;
    show();
  };
  const onChromeLeave = () => {
    pointerInChrome = false;
    arm();
  };
  bar.addEventListener('pointerenter', onChromeEnter);
  bar.addEventListener('pointerleave', onChromeLeave);
  container.addEventListener('pointermove', show);
  container.addEventListener('pointerenter', show);
  container.addEventListener('focusin', show);
  video.addEventListener('pause', show);
  video.addEventListener('ended', show);
  video.addEventListener('play', arm);

  function onKeydown(e) {
    if (!keyboard) return;
    const action = mapKeyToAction(e.key);
    if (!action) return;
    e.preventDefault();
    show();
    switch (action) {
      case 'toggle':
        togglePlay();
        flashPip(video.paused ? PAUSE_ICON : PLAY_ICON);
        break;
      case 'seek-5':
        video.currentTime = Math.max(0, video.currentTime - 5);
        flashPip(BACK_ICON);
        break;
      case 'seek+5':
        video.currentTime = video.currentTime + 5;
        flashPip(FWD_ICON);
        break;
      case 'seek-10':
        skipBy(-10);
        break;
      case 'seek+10':
        skipBy(10);
        break;
      case 'fullscreen':
        toggleFullscreen();
        break;
      case 'mute':
        video.muted = !video.muted;
        flashPip(volumeIcon(video));
        break;
    }
  }
  container.addEventListener('keydown', onKeydown);

  syncPlayIcon();
  syncVolume();
  syncDuration();
  syncTime();

  return {
    el: bar,
    setTitle,
    applyAppearance,
    /** Called by addPlayer on setSource() so the chrome resets with the new title. */
    resync() {
      scrubWrap.style.setProperty('--dxr-p', '0%');
      scrubWrap.style.setProperty('--dxr-b', '0%');
      seek.value = '0';
      seek.max = '0';
      clock.innerHTML = '<b>0:00</b><span> / 0:00</span>';
      syncPlayIcon();
      syncVolume();
      show();
    },
    cleanup() {
      clearTimeout(hideTimer);
      clearTimeout(pipTimer);
      container.removeEventListener('pointermove', show);
      container.removeEventListener('pointerenter', show);
      container.removeEventListener('focusin', show);
      container.removeEventListener('keydown', onKeydown);
      if (canFullscreen) document.removeEventListener('fullscreenchange', syncFullscreen);
      window.removeEventListener('resize', fitFullscreen);
      if (fsElement() === container) document.exitFullscreen?.().catch(() => {});
      container.classList.remove('dxr-player-host', 'dxr-player-host--idle', 'dxr-player-host--dock',
        'dxr-player-host--size-s', 'dxr-player-host--size-l');
      container.style.removeProperty('--dxr-accent');
      for (const el of [titleEl, bar, centre, pip, spinner]) el.remove();
    },
  };
}

let notedNoMixer = false;
function noteNoMixer() {
  if (notedNoMixer) return;
  notedNoMixer = true;
  console.warn(
    "[inline3d/player] setSource(…, { transition: 'crossfade' }) on a player built without one — " +
      "this swap is a CUT. Pass transition:'crossfade' to addPlayer() to create the mixer; it " +
      'cannot be created mid-flight without rebuilding the weave layer (the blink a crossfade removes).'
  );
}

// ── setSource() cross-dissolve (opts.fadeMs) ────────────────────────────────────────────────
//
// WHAT THIS ACTUALLY IS, so nobody reads more into the option name than it delivers: a dissolve
// from the outgoing title's LAST FRAME to the incoming title, not a blend of two simultaneously
// decoding streams. That distinction is invisible on screen — the outgoing title is being
// replaced, so nothing is lost by freezing it — and it costs one `<video>` instead of two, which
// is what keeps the handle, the event plumbing and the whole transport bound to a single
// element. A genuine two-stream blend would mean a second decode, a second audio track to
// arbitrate, and every getter on the handle growing an "and which video do you mean" branch.
//
// HOW IT REACHES THE WOVEN PATH. `wall.addVideo(canvas, video)` stores the source and paints it
// every frame; there is no setter to swap it afterwards, and removing + re-adding the window
// would tear down and rebuild the weave layer — a visible blink, which is exactly what the fade
// exists to avoid. But the SDK's paint reads
//
//     const srcW = src.videoWidth || src.naturalWidth || src.width;
//
// so ANY drawable with a width works as a source, and its readiness gate is
// `(src.readyState || 0) < 2`. A canvas therefore stands in for the `<video>` provided it
// answers `readyState` — hence the expando below. So when a fade is asked for, `addVideo` is
// handed a MIXER canvas that this module paints, and the stereo paint downstream of it is
// unchanged: the mixer is the same pixels in the same layout, one composite earlier.
//
// IT IS OPT-IN, AND THAT IS THE POINT. The mixer costs one extra full-frame `drawImage` per
// painted frame, so it is only created when the player was built with `transition: 'crossfade'`
// (or the legacy `fadeMs > 0`). Every player that does not ask keeps the byte-identical
// `addVideo(canvas, video)` path it has today and pays nothing. A per-call setSource option can
// therefore change a crossfade's duration or easing, or skip it, but cannot switch one on —
// there would be no mixer to run it through.

/**
 * The dissolve's alpha ramp: how much of the INCOMING title to composite over the frozen
 * outgoing frame. Pure, and exported so the ramp is testable without a canvas.
 *
 * Clamped at both ends, and a non-positive/non-finite duration collapses to a hard cut (1)
 * rather than dividing by zero and painting NaN alpha — which Chromium treats as "leave
 * globalAlpha alone", i.e. a stuck half-dissolved frame.
 *
 * @param {number} elapsedMs  time since the incoming title's first frame
 * @param {number} fadeMs
 * @returns {number} 0..1
 */
export function dissolveAlpha(elapsedMs, fadeMs) {
  if (!Number.isFinite(fadeMs) || fadeMs <= 0) return 1;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return Math.max(0, Math.min(1, elapsedMs / fadeMs));
}

/**
 * The mixer. Owns a canvas that can stand in for the `<video>` as a paint source, plus a freeze
 * buffer holding the outgoing title's last frame.
 *
 * @param {HTMLVideoElement} video
 */
function createDissolve(video) {
  const mix = document.createElement('canvas');
  const mctx = mix.getContext('2d');
  const freeze = document.createElement('canvas');
  const fctx = freeze.getContext('2d');
  let hasFreeze = false;
  let fadeMs = 0;
  let ease = PLAYER_EASINGS.linear;
  let startedAt = 0;

  // The SDK's video branch gates on `(src.readyState || 0) < 2` and re-commits the last frame
  // below it. Answering that question honestly is what lets a canvas be a drop-in source: 0
  // while there is genuinely nothing to show, 4 once the mixer holds a frame — including while
  // it holds only the FROZEN one, which is the whole reason the tile does not go black between
  // two titles.
  mix.readyState = 0;

  function size(w, h) {
    if (mix.width !== w) mix.width = w;
    if (mix.height !== h) mix.height = h;
  }
  const videoLive = () => video.readyState >= 2 && video.videoWidth > 0;

  return {
    el: mix,

    /**
     * Snapshot what is on screen, BEFORE `video.src` is pointed at the new title. Returns
     * whether there was anything to snapshot — a player swapped before its first frame has
     * nothing to dissolve from, and says so rather than fading from a blank buffer.
     */
    capture() {
      if (!videoLive()) return false;
      freeze.width = video.videoWidth;
      freeze.height = video.videoHeight;
      fctx.drawImage(video, 0, 0);
      hasFreeze = true;
      return true;
    },

    /** Arm the ramp. The clock does NOT start here — it starts at the incoming first frame. */
    arm(ms, easeFn) {
      fadeMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
      ease = typeof easeFn === 'function' ? easeFn : PLAYER_EASINGS.linear;
      startedAt = 0;
    },

    /** True while the mixer still has work only rAF can drive (a ramp, or a held freeze). */
    get active() {
      return (hasFreeze && fadeMs > 0) || (hasFreeze && !videoLive());
    },

    paint(now) {
      if (!videoLive()) {
        // Between titles: hold the outgoing frame rather than blank the tile.
        if (!hasFreeze) {
          mix.readyState = 0;
          return;
        }
        size(freeze.width, freeze.height);
        mctx.globalAlpha = 1;
        mctx.drawImage(freeze, 0, 0);
        mix.readyState = 4;
        return;
      }
      size(video.videoWidth, video.videoHeight);
      mctx.globalAlpha = 1;
      if (!hasFreeze || fadeMs <= 0) {
        mctx.drawImage(video, 0, 0, mix.width, mix.height);
        mix.readyState = 4;
        hasFreeze = false;
        return;
      }
      if (!startedAt) startedAt = now; // first frame of the incoming title
      const lin = dissolveAlpha(now - startedAt, fadeMs);
      // The curve shapes the alpha; the END is decided on the linear clock, so a page easing
      // that overshoots or never quite reaches 1 cannot leave the freeze held forever.
      const a = lin >= 1 ? 1 : Math.max(0, Math.min(1, ease(lin)));
      mctx.drawImage(freeze, 0, 0, mix.width, mix.height);
      mctx.globalAlpha = a;
      mctx.drawImage(video, 0, 0, mix.width, mix.height);
      mctx.globalAlpha = 1;
      mix.readyState = 4;
      if (lin >= 1) {
        hasFreeze = false;
        fadeMs = 0;
      }
    },
  };
}

/**
 * Keep the mixer painted for the WOVEN path, where the SDK reads the canvas on its own loop and
 * this module only has to make sure there is something current in it.
 *
 * Paints on new video frames via `requestVideoFrameCallback` in the steady state, and switches
 * to rAF while a dissolve is running — a ramp has to advance on frames the video does not
 * produce, which is precisely the case when the incoming title has not started decoding yet.
 */
/**
 * The woven path's `fit`. The SDK stretches whatever source it is handed onto the tile's SBS
 * buffer, so fitting has to happen one step earlier: this owns a canvas laid out as an SBS pair
 * whose per-eye aspect is the TILE's, and fits each eye of the upstream source (the <video>, or
 * the crossfade mixer) into its half. The SDK's stretch of that canvas is then an identity in
 * aspect. It answers `readyState` like the mixer does, which is what makes a canvas a valid
 * `addVideo` source. Opt-in: only created when `fit` is set.
 *
 * @param {() => (HTMLVideoElement|HTMLCanvasElement)} upstream
 * @param {HTMLCanvasElement} tile  the woven canvas, for its CSS aspect
 * @param {'contain'|'cover'} fit
 */
function createFitter(upstream, tile, fit) {
  const el = document.createElement('canvas');
  const ctx = el.getContext('2d');
  el.readyState = 0;
  return {
    el,
    active: false,
    paint() {
      const src = upstream();
      const vw = src.videoWidth || src.width;
      const vh = src.videoHeight || src.height;
      if ((src.readyState || 0) < 2 || !vw || !vh) return; // keep the last fitted frame
      const tw = tile.clientWidth || tile.width || 16;
      const th = tile.clientHeight || tile.height || 9;
      const eyeH = vh;
      const eyeW = Math.max(1, Math.round(eyeH * (tw / th)));
      if (el.width !== eyeW * 2) el.width = eyeW * 2;
      if (el.height !== eyeH) el.height = eyeH;
      ctx.clearRect(0, 0, el.width, el.height);
      const half = vw / 2;
      const r = fitRect(half, vh, eyeW, eyeH, fit);
      ctx.drawImage(src, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh); // left eye
      ctx.drawImage(src, half + r.sx, r.sy, r.sw, r.sh, eyeW + r.dx, r.dy, r.dw, r.dh); // right eye
      el.readyState = 4;
    },
  };
}

/** Drive one or more source stages (the crossfade mixer, the fitter) in order, per video frame. */
function driveMixer(video, stages) {
  const list = Array.isArray(stages) ? stages : [stages];
  let stopped = false;
  let rafId = 0;
  let rvfcId = 0;
  const nowMs = () =>
    typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

  function tick() {
    if (stopped) return;
    const now = nowMs();
    for (const st of list) st.paint(now);
    const canUseRvfc =
      !list.some((st) => st.active) &&
      video.readyState >= 2 &&
      typeof video.requestVideoFrameCallback === 'function';
    if (canUseRvfc) rvfcId = video.requestVideoFrameCallback(tick);
    else rafId = requestAnimationFrame(tick);
  }
  tick();

  return {
    stop() {
      stopped = true;
      if (rafId) cancelAnimationFrame(rafId);
      if (rvfcId && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(rvfcId);
      }
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
 * @param {'cut'|'crossfade'} [opts.transition='cut']  what setSource() does by default.
 *        `'crossfade'` creates the mixer (one extra full-frame draw per painted frame) — see the
 *        dissolve section; `./splat`'s other transitions are refused by name.
 * @param {number} [opts.durationMs=600]  the crossfade's length.
 * @param {string|function} [opts.easing='easeInOutSine']  a `./splat` easing name or `(x) => y`.
 * @param {'contain'|'cover'} [opts.fit]  ./splat setVideo's fit: 'contain' letterboxes each eye
 *        (transparent bars), 'cover' fills the tile and crops. Unset: stretched to the tile.
 * @param {number} [opts.fadeMs]  LEGACY alias (1.10): `> 0` = `transition:'crossfade'` of that length.
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
  let posterPoll = null;
  let mixerLoop = null;
  // Opt-in: no fade asked for at construction => no mixer, and the woven path stays the
  // byte-identical `addVideo(canvas, video)` it is today. See the dissolve section above.
  const dissolve = o.transition.type === 'crossfade' ? createDissolve(video) : null;
  // The woven path's fit stage sits after the mixer (it fits whatever the mixer composed).
  const fitter = wantWeave && o.fit ? createFitter(() => (dissolve ? dissolve.el : video), canvas, o.fit) : null;

  function paintPosterNow() {
    if (!posterImg) return;
    if (wantWeave) paintPosterSBS(canvas, posterImg);
    else ownLoop?.forceRepaint();
  }

  if (wantWeave) {
    innerHandle = wall.addVideo(canvas, fitter ? fitter.el : dissolve ? dissolve.el : video, {
      width: o.width,
      height: o.height,
      cornerRadius: o.cornerRadius,
      feather: o.feather,
      ...(o.observe ? { observe: o.observe } : {}),
    });
    if (dissolve || fitter) mixerLoop = driveMixer(video, [dissolve, fitter].filter(Boolean));
    posterPoll = startPosterPoll(canvas, () => posterImg, () => video.readyState >= 2);
  } else {
    // The flat loop paints the mixer itself rather than running a second loop beside it.
    ownLoop = attachFlatPaint(canvas, video, {
      mode: o.format === 'mono' ? 'mono' : 'sbs-fallback',
      getPoster: () => posterImg,
      dissolve,
      fit: o.fit,
    });
  }

  loadPoster(o.poster);
  video.src = resolveSrcUrl(src);
  video.load();
  if (o.autoplay) video.play().catch(() => {});

  let bar = null;
  let cleanupBar = null;
  let resyncBar = null;
  let setBarTitle = null;
  let applyBarAppearance = null;
  if (o.controls === 'sdk') {
    if (container) {
      const built = buildTransportBar(container, canvas, video, {
        keyboard: o.keyboard,
        accent: o.accent,
        badge3d: o.badge3d,
        title: o.title,
        skipButtons: o.skipButtons,
        fullscreen: o.fullscreen,
        skin: o.skin,
        size: o.size,
      });
      bar = built.el;
      cleanupBar = built.cleanup;
      resyncBar = built.resync;
      setBarTitle = built.setTitle;
      applyBarAppearance = built.applyAppearance;
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
     * Swap the source in place. `sOpts` (transition / durationMs / easing / the legacy fadeMs)
     * overrides the player's own transition field by field for this one swap — see
     * resolveTransition. A crossfade dissolves from the outgoing title's last frame (see the
     * dissolve section: not a blend of two live streams, deliberately). It cannot be switched ON
     * here for a player built without one, because the mixer that runs it only exists from
     * construction, and creating it lazily would mean swapping the woven window's paint source
     * mid-flight — a layer rebuild, i.e. the visible blink the crossfade exists to remove.
     *
     * A cut holds the old frame until the new source reaches `readyState >= 2`.
     */
    setSource(newSrc, sOpts = {}) {
      // Resolve (and validate) BEFORE touching anything: a refused option leaves the player as it was.
      const tr = resolveTransition(sOpts, o.transition);
      if (tr.type === 'crossfade' && !dissolve) noteNoMixer();
      // Snapshot BEFORE the src is repointed — once `load()` runs, the old frame is gone.
      if (dissolve && tr.type === 'crossfade' && dissolve.capture()) dissolve.arm(tr.durationMs, tr.ease);
      video.pause();
      if (sOpts.poster !== undefined) loadPoster(sOpts.poster);
      if (sOpts.title !== undefined) setBarTitle?.(sOpts.title);
      const nextCross = resolveCrossOrigin(newSrc, o.crossOrigin);
      if (nextCross) video.crossOrigin = nextCross;
      video.src = resolveSrcUrl(newSrc);
      video.load();
      // The chrome is bound to this same <video>, so its listeners survive the swap — but the
      // values they last rendered belong to the OLD title (a 24 s duration, a full scrub bar).
      // Nothing re-fires them until the new metadata lands, so reset them now rather than show
      // the previous title's numbers over the new one's first frames.
      resyncBar?.();
      // The poster is the right thing on screen again until the new source has a frame — but
      // NOT when a dissolve is running: the mixer is holding the outgoing title's last frame
      // there on purpose, and painting the poster over it is the hard cut this option exists
      // to remove.
      posterPoll?.stop();
      if (wantWeave && !dissolve?.active) {
        posterPoll = startPosterPoll(canvas, () => posterImg, () => video.readyState >= 2);
      }
      if (o.autoplay) video.play().catch(() => {});
    },
    /**
     * Re-skin the SDK transport live: any of `accent` (a CSS colour; '' = the default),
     * `size` ('s' | 'm' | 'l'), `skin` ('classic' | 'dock'). Invalid values warn and are ignored.
     * A no-op with `controls: 'none'`.
     */
    setAppearance(a = {}) {
      const next = {};
      if (a.accent !== undefined) next.accent = typeof a.accent === 'string' ? a.accent : '';
      if (a.size !== undefined) {
        const v = typeof a.size === 'string' ? a.size.toLowerCase() : a.size;
        if (VALID_SIZES.has(v)) next.size = o.size = v;
        else console.warn(`[inline3d/player] invalid size "${a.size}" — ignored`);
      }
      if (a.skin !== undefined) {
        if (VALID_SKINS.has(a.skin)) next.skin = o.skin = a.skin;
        else console.warn(`[inline3d/player] invalid skin "${a.skin}" — ignored`);
      }
      applyBarAppearance?.(next);
    },
    exclude(el) {
      innerHandle?.exclude(el);
    },
    unexclude(el) {
      innerHandle?.unexclude(el);
    },
    remove() {
      ownLoop?.stop();
      mixerLoop?.stop();
      posterPoll?.stop();
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

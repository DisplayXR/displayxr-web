// Type definitions for @displayxr/inline3d/player.
// PREVIEW tier — not covered by the 1.x semver promise. See docs/sdk-stability.md.
//
// v1 slice of docs/rfcs/0001-media-player.md. Narrower than the RFC's full plan — no `'tb'`/
// `'auto'` format, no sidecar/filename format detection, no `opts.group` playback policy, no
// `opts.fit`/letterboxing — see the report that shipped this file for the reasoning. Widening
// any of those later is additive (new optional fields), so this stays forward-compatible.

/** `'sbs'` side-by-side, `'tb'` top/bottom (left eye on top) — ./splat setVideo's names — or `'mono'`. */
export type PlayerFormat = 'sbs' | 'tb' | 'mono';

/** A source: a URL or Blob, or candidates best-first for {@link pickSource}. */
export type PlayerSource = string | Blob | Array<string | Blob | { src: string | Blob; type?: string }>;
export type PlayerControls = 'sdk' | 'none';

export interface PlayerOptions {
  /**
   * `'sbs'` (default) is a real stereo pair, woven via `wall.addVideo()` — every fallback
   * `addVideo` already has (including the browser-unsupported / off-screen-lazy one) applies for
   * free. `'mono'` is genuinely flat content: painted full-frame, never split into eyes, on a
   * small paint loop this module owns (NOT the same code path as an unsupported wall — see
   * js/inline3d-player.js's module doc comment).
   */
  format?: PlayerFormat;
  /** Painted before the first frame, and again on the video's `error` event. */
  poster?: string;
  autoplay?: boolean;
  /** Default true — required for autoplay in every browser that has one. */
  muted?: boolean;
  loop?: boolean;
  /** Default `'sdk'`. `'none'` leaves chrome to the page (handle + events + its own overlays). */
  controls?: PlayerControls;
  /**
   * Space/K play-pause, ←/→ seek ±5 s, J/L seek ±10 s, M mute. Bound to the canvas and its
   * transport, never `document`, so a page with several players drives only the focused one.
   * Default true.
   */
  keyboard?: boolean;
  /**
   * What `setSource()` does by default — the `./splat` vocabulary, the part a video can mean.
   * `'crossfade'` is opt-in HERE: it creates the mixer canvas that runs it (one extra full-frame
   * draw per painted frame), so a player that never asks keeps the byte-identical
   * `addVideo(canvas, video)` paint path and pays nothing. Default `'cut'`.
   *
   * The crossfade runs from the outgoing title's LAST FRAME to the incoming one (`./splat`'s
   * `outgoing: 'frozen'`) — not a blend of two decoding streams. On an SBS video that is not
   * the "tracking paused" look it is on a splat: the frame's disparity is baked in either way.
   * `./splat`'s other transitions (`flip`, `wavefront`, particles, sequences) move a photo's
   * gaussians and are refused by name.
   */
  transition?: PlayerTransition;
  /** The crossfade's length, ms. Default 600. */
  durationMs?: number;
  /** A `./splat` easing name, or `(x) => y` on [0, 1]. Default `'easeInOutSine'`. */
  easing?: PlayerEasing;
  /** LEGACY (the 1.10 spelling, kept as `./splat` keeps it): `> 0` = `transition: 'crossfade'` of this length. */
  fadeMs?: number;
  /**
   * Accent colour for the transport — a named preset (`'azure'` default, `'violet'`, `'magenta'`,
   * `'sunset'`, `'amber'`, `'lime'`, `'mint'`, `'ice'`) or any CSS colour. Written to the
   * `--dxr-accent` custom property on the host, so it re-skins the scrub fill, the knob, the play
   * orb, the focus rings and the spinner in one value.
   */
  accent?: PlayerAccent | (string & {});
  /**
   * Show a small pill in the control row (`true` → "3D", or your own short string). Opt-in and
   * page-driven on purpose: the module will NOT infer it from `wall.supported`, because a
   * supported wall whose tile is scrolled out of view — or whose panel is in a 2D mode — is not
   * showing 3D at that moment, and a badge that says otherwise is worse than no badge.
   */
  badge3d?: boolean | string;
  /**
   * The transport's look: `'classic'` (default) — a full-width bottom band; `'dock'` — a floating
   * rounded dock with lit round buttons and an accent orb for play.
   * `'bars'` — one row inside the bottom black bar: back / play / elapsed / scrub / remaining.
   * `'call'` — the name and a timer bar on top, the controls at the bottom, and a 2.39:1 `band`
   * by default. With a `band`, every skin puts its controls INSIDE the black bars when the bottom
   * bar is tall enough, and nothing sits over the picture. Same controls, CSS only. Both
   * keep every glow inside the overlay's own box (a shadow outside it would be woven).
   */
  skin?: 'classic' | 'dock' | 'bars' | 'call';
  /**
   * How an eye image meets a tile of a different aspect — the same names and meaning as `./splat`
   * `setVideo`'s `fit`. `'contain'`: the whole eye image, transparent bars where the aspects
   * differ (the page shows through). `'cover'`: the tile is full and the overflow is cut. Unset:
   * stretched to the tile (the 1.x behaviour). On the woven path it costs one extra draw per frame.
   */
  fit?: 'contain' | 'cover';
  /**
   * A letterbox "band" slot: the picture is fitted into a centred band of this aspect inside the
   * tile (e.g. `2.39` or `'2.39:1'` for a scope band in a 16:9 tile); the rest stays clear.
   * Implies `fit: 'contain'` unless `fit` says otherwise.
   */
  band?: number | string;
  /**
   * What the poster image is: `'mono'` (one image for both eyes, the default), or a stereo still
   * laid out like the video (`'sbs'` / `'tb'`), painted eye by eye so it is 3D before the first frame.
   */
  posterFormat?: 'mono' | 'sbs' | 'tb';
  /**
   * A playlist. With `titles` and no `src`, the first title loads. Entries may be bare sources.
   * Drive it with `play(id)`, `next()`, `back()`; `'titlechange'` fires on each switch.
   */
  titles?: ReadonlyArray<PlayerSource | { id?: string; src: PlayerSource; title?: string; poster?: string }>;
  /** `next()` past the last title wraps to the first (and `back()` from the first to the last). Default false. */
  loopList?: boolean;
  /** A title that ends moves on to the next one and plays it. Default false. */
  autoAdvance?: boolean;
  /** Transport scale — `'s'` (0.84×), `'m'` (default), `'l'` (1.28×). Icons, fonts and hit targets scale together. */
  size?: 's' | 'm' | 'l';
  /** A now-playing line over the top of the tile, fading with the transport. `setSource(src, { title })` changes it. */
  title?: string;
  /** −10 s / +10 s buttons beside play. Default true (hidden on tiles narrower than 420 px). J / L work either way. */
  skipButtons?: boolean;
  /**
   * A fullscreen button (and the F key). The canvas's CONTAINER goes fullscreen, so the transport
   * comes with it and the tile letterboxes on black. Default true; absent where the browser has no
   * Fullscreen API.
   */
  fullscreen?: boolean;
  /** Default: `'anonymous'` iff `src` is a cross-origin URL; unset (browser default) otherwise. */
  crossOrigin?: 'anonymous' | 'use-credentials';
  /** Per-eye buffer resolution in px. `'sbs'` + supported wall only — see {@link TileOptions}. */
  width?: number;
  height?: number;
  /** `'sbs'` + supported wall only. */
  cornerRadius?: number;
  feather?: number;
  /** Element whose visibility gates the lazy create/close lifecycle (`'sbs'` path only). */
  observe?: Element;
}

export type PlayerEvent = 'play' | 'pause' | 'ended' | 'timeupdate' | 'ready' | 'error' | 'titlechange';

/** One playlist entry (RFC 0001 Addendum A4). */
export interface PlayerTitle {
  /** Stable id for `play(id)`; defaults to the entry's index as a string. */
  readonly id: string;
  readonly src: PlayerSource;
  /** Shown in the title line while this title plays. */
  readonly title?: string;
  readonly poster?: string;
}

/** What {@link addPlayer} returns. Deliberately the `<video>` element's own vocabulary. */
export interface PlayerHandle {
  /** The hidden `<video>` this handle owns — escape hatch for anything not covered above. */
  readonly video: HTMLVideoElement;

  /** Resume; or, with an id (or an index into `titles`), switch to that title and play it. */
  play(id?: string | number): Promise<void>;
  pause(): void;
  /** Play if paused or ended, else pause. */
  toggle(): Promise<void>;
  /** The playlist, read-only. */
  readonly titles: ReadonlyArray<PlayerTitle>;
  /** The title playing now, or null (no playlist, or a source that is not one of its titles). */
  readonly current: PlayerTitle | null;
  /** Replace the playlist; the current title stays current if the new list has its id. */
  setTitles(list: PlayerOptions['titles']): void;
  /** The next title, playing. At the end: nothing, unless `loopList`. */
  next(): Promise<void>;
  /** A remote's "previous": restart if more than 3 s in, else the previous title. */
  back(): Promise<void>;
  /** Clamped to `[0, duration]` (or `[0, t]` before `duration` is known). */
  seek(t: number): void;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly ended: boolean;
  volume: number;
  muted: boolean;

  /**
   * Swap the source in place (and its poster, if given). Each field of `opts` overrides the
   * player's own for this one swap — `{ durationMs: 1200 }` lengthens its crossfade,
   * `{ transition: 'cut' }` skips it. A crossfade cannot be switched ON here for a player built
   * with `transition: 'cut'`: the mixer would have to become the woven window's paint source
   * mid-flight, which rebuilds the weave layer (the blink a crossfade removes). That swap is a
   * cut, and a console warning says so once.
   *
   * With a cut the old frame holds until the new source reaches `readyState >= 2`. Throws, and
   * changes nothing, on an unknown transition or easing.
   */
  setSource(src: PlayerSource, opts?: PlayerSourceOptions): void;

  /**
   * Re-skin the SDK transport live — any of `accent` (a CSS colour; `''` = the default), `size`,
   * `skin`. Invalid values warn and are ignored; a no-op with `controls: 'none'`.
   */
  setAppearance(a: { accent?: PlayerAccent | (string & {}); size?: 's' | 'm' | 'l'; skin?: 'classic' | 'dock' | 'bars' | 'call' }): void;

  /** Mark a 2D element painted over this window so the weave leaves it crisp — `'sbs'` + a
   * supported wall only; a no-op everywhere else (there is no weave to protect it from). */
  exclude(el: Element): void;
  unexclude(el: Element): void;

  /** Stop the paint loop / weave window, tear down the transport, release the `<video>`. */
  remove(): void;

  /** Returns an unsubscribe function, like {@link Inline3D.on}. */
  on(event: PlayerEvent, fn: (payload?: unknown) => void): () => void;
  off(event: PlayerEvent, fn: (payload?: unknown) => void): void;
}

/**
 * Load a media title into an inline-3D window with real transport, in one call. Safe with a
 * `null`/unsupported `wall` — it renders flat 2D instead, so pages need no branch.
 * @param wall  the manager from `createInline3D()`, or null/unsupported.
 * @param canvas  a 2D canvas ALREADY inside a container element — `controls:'sdk'` attaches the
 *        transport as a sibling of the canvas, inside `canvas.parentElement`.
 * @param src  the video URL, or a Blob/File (an object URL is created for you).
 */
export function addPlayer(
  wall: object | null | undefined,
  canvas: HTMLCanvasElement,
  /** `null` with `opts.titles` loads the first title. */
  src: PlayerSource | null,
  opts?: PlayerOptions,
): PlayerHandle;

/** The `setSource()` transitions a video can mean. */
export type PlayerTransition = 'cut' | 'crossfade';

/** `./splat`'s easing names (the same curves), or a function on [0, 1]. */
export type PlayerEasing =
  | 'linear'
  | 'easeInQuad'
  | 'easeOutQuad'
  | 'easeInOutQuad'
  | 'easeInCubic'
  | 'easeOutCubic'
  | 'easeInOutCubic'
  | 'easeInOutSine'
  | ((x: number) => number);

/** Per-call {@link PlayerHandle.setSource} options; each overrides the player's own. */
export interface PlayerSourceOptions {
  poster?: string;
  /** Replace the now-playing line ('' clears it). */
  title?: string;
  transition?: PlayerTransition;
  durationMs?: number;
  easing?: PlayerEasing;
  /** Only `'frozen'` — the player dissolves from the outgoing title's last frame. */
  outgoing?: 'frozen';
  /** LEGACY: `> 0` = a crossfade of this length, `0` = a cut. `durationMs` wins when both are given. */
  fadeMs?: number;
}

/** The resolved form `resolveTransition()` returns. */
export interface ResolvedPlayerTransition {
  type: PlayerTransition;
  /** 0 for a cut. */
  durationMs: number;
  easing: PlayerEasing;
  ease: (x: number) => number;
}

/** The named accent presets `accent` accepts (any CSS colour works too). */
export type PlayerAccent = 'azure' | 'violet' | 'magenta' | 'sunset' | 'amber' | 'lime' | 'mint' | 'ice';

/**
 * Pick the first source this browser can play from candidates listed best first; each is a URL, or
 * `{ src, type }` with a FULL `canPlayType` string (`'video/webm; codecs="vp9, opus"'`). The
 * DisplayXR Browser has no H.264/AAC, and a codec-less `'video/mp4'` still answers 'maybe'.
 */
export function pickSource(candidates: PlayerSource, canPlayType?: (type: string) => string): string | Blob | undefined;

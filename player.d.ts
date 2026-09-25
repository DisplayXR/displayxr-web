// Type definitions for @displayxr/inline3d/player.
// PREVIEW tier — not covered by the 1.x semver promise. See docs/sdk-stability.md.
//
// v1 slice of docs/rfcs/0001-media-player.md. Narrower than the RFC's full plan — no `'tb'`/
// `'auto'` format, no sidecar/filename format detection, no `opts.group` playback policy, no
// `opts.fit`/letterboxing — see the report that shipped this file for the reasoning. Widening
// any of those later is additive (new optional fields), so this stays forward-compatible.

export type PlayerFormat = 'sbs' | 'mono';
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
   * Accent colour for the transport — written to the `--dxr-accent` custom property on the
   * chrome, so it re-skins the scrub fill, the knob, the focus rings and the spinner in one
   * value. Any CSS colour. Default `#4da3ff`.
   */
  accent?: string;
  /**
   * Show a small pill in the control row (`true` → "3D", or your own short string). Opt-in and
   * page-driven on purpose: the module will NOT infer it from `wall.supported`, because a
   * supported wall whose tile is scrolled out of view — or whose panel is in a 2D mode — is not
   * showing 3D at that moment, and a badge that says otherwise is worse than no badge.
   */
  badge3d?: boolean | string;
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

export type PlayerEvent = 'play' | 'pause' | 'ended' | 'timeupdate' | 'ready' | 'error';

/** What {@link addPlayer} returns. Deliberately the `<video>` element's own vocabulary. */
export interface PlayerHandle {
  /** The hidden `<video>` this handle owns — escape hatch for anything not covered above. */
  readonly video: HTMLVideoElement;

  play(): Promise<void>;
  pause(): void;
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
  setSource(src: string | Blob, opts?: PlayerSourceOptions): void;

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
  src: string | Blob,
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


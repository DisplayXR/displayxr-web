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
   * Dissolve duration for `setSource()`, in ms. Opt-in: giving it here creates the mixer canvas
   * that runs the dissolve, so a player that never sets it keeps the byte-identical
   * `addVideo(canvas, video)` paint path and pays nothing per frame.
   *
   * The dissolve goes from the outgoing title's LAST FRAME to the incoming one — not a blend of
   * two simultaneously decoding streams. Visually identical (the outgoing title is being
   * replaced), one `<video>` instead of two.
   */
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
   * Swap the source in place (and its poster, if given), dissolving from the outgoing title's
   * last frame when a fade is armed.
   *
   * `opts.fadeMs` overrides the duration for this one swap. It cannot switch fading on — the
   * mixer exists only when {@link PlayerOptions.fadeMs} was given at construction, because
   * creating it later would mean swapping the woven window's paint source mid-flight, which
   * rebuilds the weave layer and produces exactly the blink the fade removes.
   *
   * With no fade this is a hard cut: the old frame holds until the new source reaches
   * `readyState >= 2`.
   */
  setSource(src: string | Blob, opts?: { poster?: string; fadeMs?: number }): void;

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

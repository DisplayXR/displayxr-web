// lift/state.js — the "Convert to 3D" state machine. Pure: no DOM, no WebGL, no providers.
//
//   idle ─start─▶ loading ─loaded─▶ live ⇄ freezing ─frozen─▶ lifting ─lifted─▶ explore
//                    │                ▲        │                  │                │
//                    │                └─play / resume (same tick, in-flight work abandoned)─┘
//                    └─fail─▶ error        (any live-ish state) ─hidden─▶ suspended ─visible─▶ (back)
//   (any state) ─remove / disconnected─▶ disposed
//
// The machine decides WHAT happens; lift.js executes it. Every side effect leaves the machine as a
// named EFFECT (`onEffect(name, payload)`) so the whole control flow is testable under `node --test`
// with fake timers and a fake `isPaused()`.
//
// Stale work is killed with a GENERATION counter: every freeze gets a fresh `gen`, and a `frozen` /
// `lifted` / `lift-failed` that carries an older gen is dropped on the floor. That, not promise
// cancellation, is the guarantee — a provider that ignores its AbortSignal still cannot land a
// stale explore view.

export const STATES = Object.freeze({
  IDLE: 'idle',
  LOADING: 'loading',
  LIVE: 'live',
  FREEZING: 'freezing',
  LIFTING: 'lifting',
  EXPLORE: 'explore',
  SUSPENDED: 'suspended',
  ERROR: 'error',
  DISPOSED: 'disposed',
});

/** A pause has to hold this long before it freezes: scrubbing and play/pause bounce must not lift. */
export const PAUSE_DEBOUNCE_MS = 150;

const S = STATES;
const IN_FLIGHT = new Set([S.FREEZING, S.LIFTING]);
const MEDIA_EVENTS = new Set(['pause', 'pause-settled', 'play', 'seeked', 'ended', 'emptied']);
const HIDEABLE = new Set([S.LOADING, S.LIVE, S.FREEZING, S.LIFTING, S.EXPLORE]);

/**
 * The machine mode lift() runs, from what the caller asked (`mode`, undefined = not stated).
 *   web path:  the caller's mode, default 'auto' (live while playing, lift on pause/end).
 *   native:    default 'live' for videos AND stills — the browser's vendor module keeps the paused
 *              frame woven 3D, so lifting on pause is wasted work (depth fetch, generator) that got
 *              in the way; the splat is built only on an explicit explore(). Anything the caller
 *              STATES is honoured: 'explore' (lift at once), and 'auto' for a video (lift on pause).
 *              A still has no pause, so an explicit 'auto' on a native <img> is 'live'.
 * @param {{native:boolean, kind:'video'|'still', mode?:string}} o
 * @returns {'auto'|'live'|'explore'}
 */
export function resolveLiftMode({ native, kind, mode }) {
  const m = mode === 'auto' || mode === 'live' || mode === 'explore' ? mode : undefined;
  if (!native) return m || 'auto';
  if (m === 'explore') return 'explore';
  if (m === 'auto' && kind === 'video') return 'auto';
  return 'live';
}

/**
 * @param {object} o
 * @param {'video'|'still'} o.kind   `still` = <img>/<canvas>: no live phase, straight to a lift.
 * @param {'auto'|'live'|'explore'} [o.mode='auto']
 *        auto: live while playing, lift on pause/end. live: never lift by itself (explore() still
 *        works). explore: lift as soon as the models are in.
 * @param {() => boolean} [o.isPaused]  current `element.paused` (videos); read when a debounce fires.
 * @param {(name:string, payload?:any) => void} [o.onEffect]
 * @param {(from:string, to:string, why:string) => void} [o.onState]
 * @param {number} [o.debounceMs=PAUSE_DEBOUNCE_MS]
 * @param {Function} [o.setTimer] [o.clearTimer]  injectable for tests.
 */
export function createLiftMachine(o) {
  const kind = o.kind === 'still' ? 'still' : 'video';
  const mode = o.mode === 'live' || o.mode === 'explore' ? o.mode : 'auto';
  const isPaused = o.isPaused || (() => false);
  const onEffect = o.onEffect || (() => {});
  const onState = o.onState || (() => {});
  const debounceMs = Number.isFinite(o.debounceMs) ? o.debounceMs : PAUSE_DEBOUNCE_MS;
  const setTimer = o.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer || ((id) => clearTimeout(id));

  let state = S.IDLE;
  let gen = 0;
  let pauseTimer = null;
  // suspended bookkeeping: where to go back to, and whether `loaded` arrived while away.
  let resumeTo = null;
  let loadedWhileAway = false;

  const effect = (name, payload) => onEffect(name, payload);
  const go = (to, why) => {
    if (to === state) return;
    const from = state;
    state = to;
    onState(from, to, why);
  };
  const cancelPause = () => {
    if (pauseTimer !== null) {
      clearTimer(pauseTimer);
      pauseTimer = null;
    }
  };
  const schedulePause = () => {
    cancelPause();
    pauseTimer = setTimer(() => {
      pauseTimer = null;
      m.send('pause-settled');
    }, debounceMs);
  };
  // Start a fresh freeze → lift. `why` is only for the statechange event.
  const startFreeze = (why) => {
    cancelPause();
    gen++;
    go(S.FREEZING, why);
    effect('freeze', { gen });
  };
  // Abandon an in-flight freeze/lift (the gen bump makes any late result stale).
  const cancelInFlight = () => {
    gen++;
    effect('cancelLift');
  };
  const backToLive = (why, { reset = false } = {}) => {
    if (IN_FLIGHT.has(state)) cancelInFlight();
    if (state === S.EXPLORE) effect('exitExplore', { crossfade: why === 'play' || why === 'resume' });
    if (reset) effect('resetProvider');
    go(S.LIVE, why);
  };
  // Play must never wait on explore work (pause → explore is only acceptable if play is instant):
  // a resume goes live IN THIS TICK — the in-flight freeze/lift is abandoned (gen bump + abort),
  // not awaited — and only then asks the media to play (its `play` event then lands in LIVE).
  const resumeNow = () => {
    backToLive('resume');
    if (kind === 'video') effect('playMedia');
  };
  const afterLoaded = () => {
    if (kind === 'still' || mode === 'explore') return startFreeze('loaded');
    go(S.LIVE, 'loaded');
    effect('startLive');
    // A video that was already paused (or ended) when lift() was called lifts as if it just paused.
    if (mode === 'auto' && isPaused()) schedulePause();
  };

  const m = {
    get state() {
      return state;
    },
    get gen() {
      return gen;
    },
    kind,
    mode,
    /** Feed an event. Unknown / inapplicable events are ignored (returns false). */
    send(ev, data = {}) {
      if (state === S.DISPOSED) return false;

      // ── global events ───────────────────────────────────────────────────────────────
      if (ev === 'remove' || ev === 'disconnected') {
        cancelPause();
        if (IN_FLIGHT.has(state)) cancelInFlight();
        go(S.DISPOSED, ev);
        effect('dispose', { reason: ev });
        return true;
      }
      if (ev === 'fatal') {
        cancelPause();
        if (IN_FLIGHT.has(state)) cancelInFlight();
        go(S.ERROR, 'fatal');
        effect('fail', { error: data.error });
        return true;
      }
      if (ev === 'hidden' && HIDEABLE.has(state)) {
        cancelPause();
        if (IN_FLIGHT.has(state)) cancelInFlight();
        resumeTo = state;
        loadedWhileAway = false;
        go(S.SUSPENDED, 'hidden');
        effect('suspend');
        return true;
      }
      // Stale async results: dropped regardless of state.
      if ((ev === 'frozen' || ev === 'lifted' || ev === 'lift-failed') && data.gen !== gen) return false;

      // A still has no playback: media events cannot reach it (and must not, if a page forwards them).
      if (kind === 'still' && MEDIA_EVENTS.has(ev)) return false;

      switch (state) {
        case S.IDLE:
          if (ev === 'start') {
            go(S.LOADING, 'start');
            effect('load');
            return true;
          }
          return false;

        case S.LOADING:
          if (ev === 'loaded') return afterLoaded(), true;
          if (ev === 'fail') {
            go(S.ERROR, 'load-failed');
            effect('fail', { error: data.error });
            return true;
          }
          return false;

        case S.LIVE:
          if (ev === 'pause') {
            if (mode === 'auto') schedulePause();
            return true;
          }
          if (ev === 'pause-settled') {
            // only auto mode lifts on pause (a stray settle must not lift a `live` — e.g. native — lift)
            if (mode === 'auto' && isPaused()) startFreeze('pause');
            return true;
          }
          if (ev === 'play') {
            cancelPause();
            return true;
          }
          if (ev === 'seeked') {
            if (isPaused()) {
              if (mode === 'auto') schedulePause();
            } else effect('resetProvider');
            return true;
          }
          if (ev === 'ended') {
            if (mode !== 'live') startFreeze('ended');
            return true;
          }
          if (ev === 'emptied') {
            cancelPause();
            effect('resetProvider');
            return true;
          }
          if (ev === 'explore-request') {
            if (!isPaused()) effect('pauseMedia'); // its `pause` event lands in FREEZING and is ignored
            startFreeze('explore');
            return true;
          }
          return false;

        case S.FREEZING:
        case S.LIFTING:
          if (ev === 'frozen' && state === S.FREEZING) {
            go(S.LIFTING, 'frozen');
            effect('lift', { gen });
            return true;
          }
          if (ev === 'lifted' && state === S.LIFTING) {
            go(S.EXPLORE, 'lifted');
            effect('enterExplore', { gen });
            return true;
          }
          if (ev === 'lift-failed') {
            // Non-fatal for a video (it still has its live view); fatal for a still (nothing to show).
            effect('liftError', { error: data.error });
            if (kind === 'still') {
              go(S.ERROR, 'lift-failed');
              effect('fail', { error: data.error });
            } else backToLive('lift-failed');
            return true;
          }
          if (ev === 'play') return backToLive('play'), true;
          if (ev === 'resume-request') return resumeNow(), true;
          if (ev === 'emptied') return backToLive('emptied', { reset: true }), true;
          if (ev === 'seeked') {
            if (isPaused()) {
              cancelInFlight();
              startFreeze('seeked');
            } else backToLive('seeked', { reset: true });
            return true;
          }
          return false; // pause / ended / explore-request while already lifting: nothing to do

        case S.EXPLORE:
          if (ev === 'play') return backToLive('play'), true;
          if (ev === 'resume-request') return resumeNow(), true;
          if (ev === 'emptied') return backToLive('emptied', { reset: true }), true;
          if (ev === 'seeked') {
            if (isPaused()) {
              effect('exitExplore', { crossfade: false });
              startFreeze('seeked');
            } else backToLive('seeked', { reset: true });
            return true;
          }
          return false;

        case S.SUSPENDED:
          if (ev === 'loaded') {
            loadedWhileAway = true;
            return true;
          }
          if (ev === 'visible') {
            const to = resumeTo;
            resumeTo = null;
            effect('resume');
            if (to === S.LOADING) {
              go(S.LOADING, 'visible');
              if (loadedWhileAway) afterLoaded();
            } else if (to === S.EXPLORE) {
              go(S.EXPLORE, 'visible');
            } else if (to === S.FREEZING || to === S.LIFTING) {
              // The in-flight lift was cancelled on hide; start it again if it still applies.
              if (kind === 'still' || isPaused() || mode === 'explore') startFreeze('visible');
              else {
                go(S.LIVE, 'visible');
              }
            } else {
              go(S.LIVE, 'visible');
              if (mode === 'auto' && kind === 'video' && isPaused()) schedulePause();
            }
            return true;
          }
          if (ev === 'play' || ev === 'emptied') {
            // Remember that the media moved on; come back live rather than to a stale explore view.
            if (resumeTo === S.EXPLORE) effect('exitExplore', { crossfade: false });
            if (resumeTo !== S.LOADING) resumeTo = S.LIVE;
            if (ev === 'emptied') effect('resetProvider');
            return true;
          }
          return false;

        case S.ERROR:
          return false;
      }

      return false;
    },
  };

  return m;
}

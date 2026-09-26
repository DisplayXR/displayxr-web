// lift/ui.js — the builtin chip: a small pill in the lifted element's top-right corner.
//
// Lives inside the placement's CLOSED shadow root, so page CSS cannot restyle it and it cannot
// restyle the page. It is 2D DOM painted over a woven canvas, so lift.js registers it with the
// window's exclude() (a no-op on draw-order-occlusion browsers, where it is automatic).
//
// Shows: loading/converting progress, and the actions that apply to the current state —
//   live → "Explore"   explore → "SOG" (download) + "Resume" (videos) + "Exit"   error → "Exit"
// `ui: 'none'` never creates it; the page drives the handle itself.
//
// Auto-hide (`autoHideMs`, lift.js defaults it ON in native mode only): the DisplayXR Browser's
// native lift crops the element's whole on-screen rect out of the page raster and weaves the
// vendor's conversion back into it, so a chip INSIDE that rect is converted and woven like video
// content. Until the browser splits planes for lift rects, the chip fades out after `autoHideMs`
// without pointer activity over the element (or the chip) and comes back on the next move/press.

const CSS = `
.chip{position:absolute;top:8px;right:8px;display:flex;gap:4px;align-items:center;
  font:600 12px/1 system-ui,-apple-system,"Segoe UI",sans-serif;color:#fff;
  background:rgba(20,20,24,.92);border-radius:999px;padding:4px 4px 4px 10px;
  pointer-events:auto;user-select:none;-webkit-user-select:none;
  box-shadow:0 1px 4px rgba(0,0,0,.35)}
/* No backdrop-filter: frosted chrome over a woven tile makes the DisplayXR Browser send the tile
   RAW (SBS visible on the panel) — docs/authoring-inline-3d.md: near-solid background, no blur. */
.chip[hidden]{display:none}
.chip{transition:opacity .15s ease,visibility 0s linear 0s}
.chip.autohidden{opacity:0;visibility:hidden;pointer-events:none;
  transition:opacity .15s ease,visibility 0s linear .15s}
.label{white-space:nowrap;padding-right:4px;font-variant-numeric:tabular-nums}
.label[hidden]{display:none}
.chip:has(.label[hidden]){padding-left:4px}
button{all:unset;cursor:pointer;padding:4px 9px;border-radius:999px;background:rgba(255,255,255,.16)}
button:hover{background:rgba(255,255,255,.3)}
button:focus-visible{outline:2px solid #7cb7ff;outline-offset:1px}
button[hidden]{display:none}
button[disabled]{opacity:.6;cursor:progress}
`;

const LABELS = {
  idle: '3D',
  loading: 'Loading 3D',
  live: '3D',
  freezing: 'Converting',
  lifting: 'Converting',
  explore: '3D',
  suspended: '3D',
  error: '3D unavailable',
  disposed: '',
};

/** Every input a drag/click on our own overlay produces — incl. the synthetic `click` after a drag,
 *  the compat mouse events and touch. Not `contextmenu` (the browser's Convert-to-3D menu lives
 *  there) and not `wheel` (page scroll). */
export const SHIELDED_EVENTS = Object.freeze([
  'pointerdown', 'pointermove', 'pointerup', 'pointercancel',
  'mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'auxclick',
  'touchstart', 'touchmove', 'touchend', 'touchcancel',
]);

/**
 * Keep input on our overlay (the explore canvas, the chip) away from the PAGE: a player under it
 * (YouTube toggles play on click) must never see the drag's pointerup / the click after it — an
 * orbit drag used to unpause the video on release. stopPropagation + preventDefault, bubble phase
 * on the target, so our own listeners on the same node still run. `isActive()` gates it (default
 * always). Returns an `off()`.
 * @param {EventTarget} target
 * @param {{isActive?:() => boolean, preventDefault?:boolean}} [o]
 */
export function shieldInput(target, o = {}) {
  const isActive = o.isActive || (() => true);
  const prevent = o.preventDefault !== false;
  const onEv = (ev) => {
    if (!isActive()) return;
    ev.stopPropagation();
    if (prevent && ev.cancelable) ev.preventDefault();
  };
  const opt = { passive: false }; // touchstart/move must be cancelable
  for (const t of SHIELDED_EVENTS) target.addEventListener(t, onEv, opt);
  return () => {
    for (const t of SHIELDED_EVENTS) target.removeEventListener(t, onEv, opt);
  };
}

/**
 * The auto-hide timer, DOM-free (unit-tested): `poke()` shows and restarts the countdown, `hold(on)`
 * pins it visible (keyboard focus inside the chip), `onChange(visible)` fires on every flip.
 * `ms <= 0` disables it (always visible).
 * @param {{ms:number, onChange:(visible:boolean)=>void, setTimer?:Function, clearTimer?:Function}} o
 */
export function createAutoHide(o) {
  const ms = Number.isFinite(o.ms) ? o.ms : 0;
  const setTimer = o.setTimer || ((fn, t) => setTimeout(fn, t));
  const clearTimer = o.clearTimer || ((id) => clearTimeout(id));
  let visible = true;
  let held = false;
  let timer = null;
  const set = (v) => {
    if (v === visible) return;
    visible = v;
    o.onChange(v);
  };
  const stop = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const arm = () => {
    stop();
    if (ms > 0 && !held) {
      timer = setTimer(() => {
        timer = null;
        if (!held) set(false);
      }, ms);
    }
  };
  return {
    get enabled() {
      return ms > 0;
    },
    get visible() {
      return visible;
    },
    /** Activity (pointer over the element, a note, progress): show now, hide `ms` later. */
    poke() {
      set(true);
      arm();
    },
    /** Pin visible (true) — e.g. a chip button has keyboard focus — or release the pin (false). */
    hold(on) {
      held = !!on;
      set(true);
      if (held) stop();
      else arm();
    },
    dispose() {
      stop();
    },
  };
}

/**
 * What the chip shows for a state — pure (unit-tested).
 *   video: live → "3D" + Explore + Exit; explore → ↓ SOG + Resume + Exit.
 *   still (a picture — it converts straight to explore): ↓ SOG + Exit only; no Explore / Resume and
 *     no "3D" label; the label appears only while busy (progress / provider note) or on error.
 *     Exit is offered while it converts too.
 * @param {string} state
 * @param {{kind:'video'|'still', canDownload?:boolean}} o
 * @returns {{label:boolean, explore:boolean, sog:boolean, resume:boolean, exit:boolean}}
 */
export function chipLayout(state, o) {
  const busy = state === 'loading' || state === 'freezing' || state === 'lifting';
  const still = o.kind === 'still';
  return {
    label: still ? busy || state === 'error' : true,
    explore: !still && state === 'live',
    sog: state === 'explore' && !!o.canDownload,
    resume: !still && state === 'explore',
    exit: still ? state !== 'disposed' && state !== 'idle' : state === 'explore' || state === 'error' || state === 'live',
  };
}

/**
 * @param {ShadowRoot} root
 * @param {{kind:'video'|'still', onExplore():void, onResume():void, onExit():void, onDownload?():void}} actions
 * @param {{autoHideMs?:number, activityRect?:() => DOMRect|{left:number,top:number,right:number,bottom:number}|null}} [opts]
 *        autoHideMs > 0: fade out after that long without pointer activity inside `activityRect()`
 *        (the lifted element's rect) or over the chip.
 */
export function createChip(root, actions, opts = {}) {
  const style = document.createElement('style');
  style.textContent = CSS;
  const chip = document.createElement('div');
  chip.className = 'chip';
  chip.setAttribute('part', 'chip');
  const label = document.createElement('span');
  label.className = 'label';
  const mk = (text, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      fn();
    });
    // Keep pointer input on the chip away from the explore orbit underneath.
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    return b;
  };
  const bExplore = mk('Explore', actions.onExplore);
  const bResume = mk('Resume', actions.onResume);
  const bExit = mk('Exit', actions.onExit);
  // "Download SOG": the lifted scene as a .sog with the camera block (lift.js downloadSog).
  const bSog = mk('↓ SOG', () => actions.onDownload?.());
  bSog.title = 'Download the 3D scene (.sog)';
  chip.append(label, bExplore, bSog, bResume, bExit);
  root.append(style, chip);
  // A click anywhere on the chip (its label too) must not reach a player under it.
  const offShield = shieldInput(chip, { preventDefault: false });

  let state = 'idle';
  let progress = null;
  let saving = false;
  let note = null; // a provider's own status ("Lifting with SHARP… 7s"), shown instead of the % while busy
  const render = () => {
    const base = LABELS[state] ?? '3D';
    const busy = state === 'loading' || state === 'freezing' || state === 'lifting';
    label.textContent = busy && note ? note : busy && progress != null ? `${base} ${Math.round(progress * 100)}%` : busy ? `${base}…` : base;
    const L = chipLayout(state, { kind: actions.kind, canDownload: !!actions.onDownload });
    label.hidden = !L.label;
    bExplore.hidden = !L.explore;
    bSog.hidden = !L.sog;
    bSog.disabled = saving;
    bSog.textContent = saving ? 'Saving…' : '↓ SOG';
    bResume.hidden = !L.resume;
    bExit.hidden = !L.exit;
    chip.hidden = state === 'disposed';
  };
  render();

  // ── auto-hide ──────────────────────────────────────────────────────────────────────────
  const auto = createAutoHide({ ms: opts.autoHideMs || 0, onChange: (v) => chip.classList.toggle('autohidden', !v) });
  let offActivity = () => {};
  if (auto.enabled) {
    // Document-level capture: the element may sit under a player's own overlay, and the chip's
    // buttons stop propagation. A rect test decides whether the pointer is "over the element".
    const inside = (ev) => {
      const r = opts.activityRect ? opts.activityRect() : null;
      if (!r) return false;
      return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
    };
    // (A closed shadow root hides the chip from composedPath() at document level, so the chip
    // gets its own capture listeners — its buttons stop propagation of pointerdown.)
    const onDocPointer = (ev) => {
      if (inside(ev)) auto.poke();
    };
    const onChipPointer = () => auto.poke();
    // KEYBOARD focus pins it (a mouse click also focuses the button — that must not pin it).
    const onFocusIn = (ev) => {
      let kb = false;
      try {
        kb = ev.target.matches(':focus-visible');
      } catch {
        kb = true; // no :focus-visible support: err on the side of staying visible
      }
      if (kb) auto.hold(true);
    };
    const onFocusOut = (ev) => auto.hold(!!(ev.relatedTarget && chip.contains(ev.relatedTarget)));
    const doc = root.ownerDocument || document;
    const cap = { capture: true, passive: true };
    doc.addEventListener('pointermove', onDocPointer, cap);
    doc.addEventListener('pointerdown', onDocPointer, cap);
    chip.addEventListener('pointermove', onChipPointer, cap);
    chip.addEventListener('pointerdown', onChipPointer, cap);
    chip.addEventListener('focusin', onFocusIn);
    chip.addEventListener('focusout', onFocusOut);
    offActivity = () => {
      doc.removeEventListener('pointermove', onDocPointer, cap);
      doc.removeEventListener('pointerdown', onDocPointer, cap);
      chip.removeEventListener('pointermove', onChipPointer, cap);
      chip.removeEventListener('pointerdown', onChipPointer, cap);
      chip.removeEventListener('focusin', onFocusIn);
      chip.removeEventListener('focusout', onFocusOut);
      auto.dispose();
    };
    auto.poke(); // visible at mount, hides after the first quiet period
  }

  return {
    el: chip,
    /** Auto-hide: currently shown (always true when auto-hide is off). */
    get visible() {
      return auto.visible;
    },
    setState(s) {
      const changed = s !== state;
      state = s;
      if (!(s === 'loading' || s === 'freezing' || s === 'lifting')) progress = note = null;
      render();
      if (changed && auto.enabled) auto.poke(); // a new state is feedback: show it briefly
    },
    /** A long action in flight (only 'download' today): disables its button, relabels it. */
    setBusy(what, on) {
      if (what === 'download') saving = !!on;
      render();
    },
    /** A status line that replaces the percentage while busy (null clears it). */
    setNote(text) {
      note = text ? String(text) : null;
      render();
      if (note && auto.enabled) auto.poke(); // user feedback: re-show briefly, then the timer applies
    },
    setProgress(p) {
      progress = p == null ? null : Math.max(0, Math.min(1, p));
      render();
      if (progress != null && auto.enabled) auto.poke();
    },
    dispose() {
      offActivity();
      offShield();
      chip.remove();
      style.remove();
    },
  };
}

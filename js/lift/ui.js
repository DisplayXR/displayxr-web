// lift/ui.js — the builtin chip: a small pill in the lifted element's top-right corner.
//
// Lives inside the placement's CLOSED shadow root, so page CSS cannot restyle it and it cannot
// restyle the page. It is 2D DOM painted over a woven canvas, so lift.js registers it with the
// window's exclude() (a no-op on draw-order-occlusion browsers, where it is automatic).
//
// Shows: loading/converting progress, and the actions that apply to the current state —
//   live → "Explore"   explore → "SOG" (download) + "Resume" (videos) + "Exit"   error → "Exit"
// `ui: 'none'` never creates it; the page drives the handle itself.

const CSS = `
.chip{position:absolute;top:8px;right:8px;display:flex;gap:4px;align-items:center;
  font:600 12px/1 system-ui,-apple-system,"Segoe UI",sans-serif;color:#fff;
  background:rgba(20,20,24,.92);border-radius:999px;padding:4px 4px 4px 10px;
  pointer-events:auto;user-select:none;-webkit-user-select:none;
  box-shadow:0 1px 4px rgba(0,0,0,.35)}
/* No backdrop-filter: frosted chrome over a woven tile makes the DisplayXR Browser send the tile
   RAW (SBS visible on the panel) — docs/authoring-inline-3d.md: near-solid background, no blur. */
.chip[hidden]{display:none}
.label{white-space:nowrap;padding-right:4px;font-variant-numeric:tabular-nums}
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

/**
 * @param {ShadowRoot} root
 * @param {{kind:'video'|'still', onExplore():void, onResume():void, onExit():void, onDownload?():void}} actions
 */
export function createChip(root, actions) {
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

  let state = 'idle';
  let progress = null;
  let saving = false;
  let note = null; // a provider's own status ("Lifting with SHARP… 7s"), shown instead of the % while busy
  const render = () => {
    const base = LABELS[state] ?? '3D';
    const busy = state === 'loading' || state === 'freezing' || state === 'lifting';
    label.textContent = busy && note ? note : busy && progress != null ? `${base} ${Math.round(progress * 100)}%` : busy ? `${base}…` : base;
    bExplore.hidden = state !== 'live';
    bSog.hidden = state !== 'explore' || !actions.onDownload;
    bSog.disabled = saving;
    bSog.textContent = saving ? 'Saving…' : '↓ SOG';
    bResume.hidden = !(state === 'explore' && actions.kind === 'video');
    bExit.hidden = !(state === 'explore' || state === 'error' || state === 'live');
    chip.hidden = state === 'disposed';
  };
  render();
  return {
    el: chip,
    setState(s) {
      state = s;
      if (!(s === 'loading' || s === 'freezing' || s === 'lifting')) progress = note = null;
      render();
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
    },
    setProgress(p) {
      progress = p == null ? null : Math.max(0, Math.min(1, p));
      render();
    },
    dispose() {
      chip.remove();
      style.remove();
    },
  };
}

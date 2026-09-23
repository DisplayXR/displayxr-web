// inline3d-splat-shared.js — the small pieces both splat backends use, written once.
//
// EXPERIMENTAL. Internal to `./splat` (Spark) and its `engine: 'playcanvas'` backend. Not covered
// by the SDK's 1.x semver promise.
//
// Everything here is renderer-free: no three.js, no engine. The Spark path
// (./inline3d-splat.js) and the PlayCanvas adapter (./inline3d-splat-playcanvas.js) both import
// it, so a gesture or a coordinate convention cannot drift between the two.
//
// (SceneViewer in ./inline3d-viewer.js keeps its own module-private clamp/finite/now: P1 of
// epic #36 deliberately leaves that module untouched.)

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** NaN/Infinity into a transform silently blanks the tile; reject at the setter instead. */
export const finite = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** [x,y,z] out of anything vector-shaped. */
export function toArray3(v) {
  return Array.isArray(v) ? [v[0], v[1], v[2]] : [v.x, v.y, v.z];
}

/**
 * NDC of a client point, from the canvas's CSS box — null for an empty box.
 *
 * The CSS box, not the backing store: on a woven canvas the store is double-width and each eye
 * owns half of it, but what the VIEWER sees is one image filling the box, so the box is the
 * right frame to pick in; the eye camera supplies the parallax-correct ray.
 */
export function canvasNdc(canvas, clientX, clientY) {
  const box = canvas.getBoundingClientRect();
  if (!(box.width > 0) || !(box.height > 0)) return null;
  return {
    x: ((clientX - box.left) / box.width) * 2 - 1,
    y: -(((clientY - box.top) / box.height) * 2 - 1),
  };
}

/**
 * The two focus gestures: double-click focuses what was clicked, Space goes back to the resolved
 * focus.
 *
 * Space is scoped to THIS window: a page with four splat tiles must not have one key reset all
 * four. Hover OR keyboard focus, so it works with a pointer and with a keyboard.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} h
 * @param {(e: MouseEvent) => boolean} h.onDoubleClick  apply the pick; return true when something
 *        was hit (the event's default is then prevented), false to let it through.
 * @param {() => void} h.onReset  Space.
 * @returns {(() => void)|null} unbind, or null when the canvas cannot take listeners.
 */
export function bindFocusGestures(canvas, { onDoubleClick, onReset }) {
  if (typeof canvas.addEventListener !== 'function') return null;
  let hovering = false;
  const onEnter = () => {
    hovering = true;
  };
  const onLeave = () => {
    hovering = false;
  };
  const onDblClick = (e) => {
    if (onDoubleClick(e)) e.preventDefault();
  };
  const onKeyDown = (e) => {
    if (e.code !== 'Space' && e.key !== ' ') return;
    if (!hovering && document.activeElement !== canvas) return;
    e.preventDefault();
    onReset();
  };
  canvas.addEventListener('pointerenter', onEnter);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('dblclick', onDblClick);
  addEventListener('keydown', onKeyDown);
  return () => {
    canvas.removeEventListener('pointerenter', onEnter);
    canvas.removeEventListener('pointerleave', onLeave);
    canvas.removeEventListener('dblclick', onDblClick);
    removeEventListener('keydown', onKeyDown);
  };
}

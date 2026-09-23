// inline3d-splat-shared.js — the small pieces both splat backends use, written once.
//
// EXPERIMENTAL. Internal to `./splat` (Spark) and its `engine: 'playcanvas'` backend. Not covered
// by the SDK's 1.x semver promise.
//
// Everything here is renderer-free: no three.js, no engine. The Spark path
// (./inline3d-splat.js) and the PlayCanvas adapter (./inline3d-splat-playcanvas.js) both import
// it, so a gesture or a coordinate convention cannot drift between the two.
//
// The VIEWER CONSTANTS below are read by BOTH SceneViewer (./inline3d-viewer.js, the Spark path)
// and PlayCanvasSplatViewer (./inline3d-splat-playcanvas.js), so the two backends cannot drift
// apart on how a drag, a wheel notch, an idle turntable or a focus change feels. Pinned by
// test/splat-playcanvas.test.mjs (values, and a behavioural trace of both viewers side by side).

/**
 * Backstop on total subject depth, as a multiple of the display height. Generous on purpose:
 * depth placement is a z decision (see fitTo), not a scale one, so this only catches the
 * pathological case where a subject is so deep that no placement helps.
 */
export const DEFAULT_DEPTH_LIMIT = 4.0;
/** Milliseconds of no interaction before the idle turntable starts. */
export const IDLE_DELAY_MS = 2500;
/**
 * Per-frame easing factor for a focus change, matching the gallery's `EASE`.
 *
 * Deliberately per FRAME and not per second, because that is what the reference implementation
 * does and a focus change is a one-off gesture response rather than a continuous motion — the
 * difference between 60 and 120 Hz here is a settle that takes half as long, not a bug.
 */
export const FOCUS_EASE = 0.18;
/** Yaw/pitch/zoom damping: each frame closes `1 − DAMP_BASE^dt` of the gap (dt in seconds). */
export const DAMP_BASE = 0.001;
/** Largest frame step the damping will take, seconds — a stall must not become a lurch. */
export const MAX_DT_S = 0.1;
/** Default pitch clamp, degrees: stops the viewer rolling under the subject. */
export const PITCH_LIMIT = Object.freeze([-60, 60]);
/** A full drag across the tile is this many degrees — a half turn, whatever the tile size. */
export const DRAG_DEG_PER_TILE = 180;
/**
 * Wheel-zoom tuning.
 *
 * ZOOM_PER_PX is set so one ordinary mouse notch (~100 px in Chrome) is about a 10% step, which
 * puts a trackpad's 1-10 px events at a fraction of a percent each — small enough that the easing
 * reads as continuous rather than as a stack of jumps.
 *
 * A deltaMode-1 "line" is sized to match a wheel DETENT, not a line of text. Firefox reports a
 * notch as deltaY 3 in lines where Chrome reports it as ~100 in pixels, so 33 makes one physical
 * notch feel the same in both; 16 (a text line) would make Firefox roughly half as responsive as
 * Chrome for identical hardware.
 */
export const WHEEL_LINE_PX = 33;
/** A "page" in deltaMode 2; rare, but it must not be unbounded. */
export const WHEEL_PAGE_PX = 400;
/** Per-event ceiling, against OS pointer acceleration spikes. */
export const WHEEL_MAX_PX = 120;
export const ZOOM_PER_PX = 0.001;
export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 6;
/** The mono fallback camera: a plain perspective camera, vertical FOV in degrees, near, far. */
export const MONO_FOV = 35;
export const MONO_NEAR = 0.001;
export const MONO_FAR = 1000;
/**
 * The camera rig's far plane. A deconverged capture parks its sky at the lifter's depth cap and
 * the refinement scatters some gaussians beyond it (239 m measured on a street scene); anything
 * past the far plane is clipped and pops out as a black hole the moment an orbit pushes it over.
 */
export const CAPTURE_FAR = 5000;

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

/** URL path without query/hash; '' for non-strings. */
export function pathOf(u) {
  return typeof u === 'string' ? u.split(/[?#]/)[0] : '';
}

function extOf(u) {
  const m = /\.([a-z0-9]+)$/i.exec(pathOf(u));
  return m ? m[1].toLowerCase() : '';
}

/** Spark's `fileType` names, as the PlayCanvas engine's parser extensions (null = unreadable). */
const PC_FILETYPE = { pcsogszip: 'sog', ply: 'ply' };

/**
 * Which PlayCanvas loader a source needs. The engine picks its parser from the URL's extension;
 * a byte source gets a synthetic name so it does too.
 *
 * @param {string|null} src  the URL (ignored when `bytes` is given).
 * @param {Uint8Array|null} [bytes]
 * @param {string} [fileName]  the `.splat`/`.ksplat` disambiguator; its extension is a hint here.
 * @param {string} [fileType]  Spark's type name, if the page passed one.
 * @returns {{ext:'sog'|'ply'|'json', streamed:boolean}|null} null = not something the engine reads.
 */
export function engineFormatFor(src, bytes, fileName, fileType) {
  if (fileType !== undefined) {
    const ext = PC_FILETYPE[fileType];
    return ext ? { ext, streamed: false } : null;
  }
  if (bytes) {
    if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
      return { ext: 'sog', streamed: false };
    }
    if (bytes.length >= 3 && bytes[0] === 0x70 && bytes[1] === 0x6c && bytes[2] === 0x79) return { ext: 'ply', streamed: false };
    const e = extOf(fileName);
    return e === 'sog' || e === 'ply' ? { ext: e, streamed: false } : null;
  }
  const e = extOf(src);
  if (e === 'sog' || e === 'ply') return { ext: e, streamed: false };
  if (e === 'json') return { ext: 'json', streamed: /lod-meta\.json$/i.test(pathOf(src)) };
  return null;
}

// ── ORBIT: the PlayCanvas backend's built-in drag (tilt-and-relax) ──────────────────────────
//
// SceneViewer (the Spark path) still turns the subject cumulatively (DRAG_DEG_PER_TILE); switching
// it to this mapping later is reading these three constants.

/** Largest tilt a drag reaches, degrees, either axis; a half-width swipe gets there. */
export const ORBIT_MAX_DEG = 15;
/** Time constant while dragging, seconds: k = 1 − exp(−dt/τ) per frame toward the drag target. */
export const ORBIT_TAU_DRAG_S = 0.2;
/** Time constant of the relax back to rest after release, seconds. */
export const ORBIT_TAU_REST_S = 0.6;

/**
 * The capture camera's off-axis WINDOW at the near plane — the one projection both backends'
 * camera rigs draw the mono (flat) view through. Principal point honoured, so a deconverged
 * capture (`cx` off centre) keeps its lens shift. OpenCV's y grows DOWN the image, so the TOP
 * edge is the `cy` side.
 *
 * `captureFit` decides what gives when the canvas is not the capture's shape:
 *   'height' (default) — the capture's VERTICAL extent is kept and the horizontal is widened or
 *            narrowed to the canvas. Keeps a face the same size whatever shape the tile is; a
 *            tile wider than the capture shows past the photograph's left/right edges.
 *   'cover'  — the tile is always filled by photograph: when the canvas is WIDER than the capture
 *            the horizontal extent is kept and the vertical is cropped (a 4:3 capture in a 16:9
 *            tile loses top and bottom); when it is narrower this is 'height' (which already
 *            crops the sides).
 *
 * @param {{fx:number,fy:number,cx:number,cy:number,width:number,height:number}} K  intrinsics.
 * @param {number} aspect  canvas width / height (non-positive → the capture's own aspect).
 * @param {number} near
 * @param {'height'|'cover'} [captureFit='height']
 * @returns {{left:number,right:number,top:number,bottom:number}}
 */
export function captureWindow(K, aspect, near, captureFit = 'height') {
  const { fx, fy, cx, cy, width, height } = K;
  const top = (near * cy) / fy;
  const bottom = -(near * (height - cy)) / fy;
  const a = aspect > 0 ? aspect : width / height;
  if (captureFit === 'cover') {
    const left0 = -(near * cx) / fx;
    const right0 = (near * (width - cx)) / fx;
    const capAspect = (right0 - left0) / (top - bottom);
    if (a > capAspect) {
      const vmid = (top + bottom) / 2;
      const halfV = (right0 - left0) / a / 2;
      return { left: left0, right: right0, top: vmid + halfV, bottom: vmid - halfV };
    }
  }
  const mid = (near * (width / 2 - cx)) / fx; // horizontal centre of the capture's frustum
  const half = ((top - bottom) * a) / 2;
  return { left: mid - half, right: mid + half, top, bottom };
}

/** The camera-rig fits `captureFit` accepts. Anything else throws at addSplat time. */
export const CAPTURE_FITS = Object.freeze(['height', 'cover']);

/**
 * Full vertical FOV, DEGREES, of what the capture camera shows under `captureFit` — what the
 * camera-rig descriptor sends the runtime, so 3D crops like the flat view does. On 'height' it is
 * the lens's own `2·atan(h / 2fy)`, bit for bit.
 */
export function captureVerticalFovDeg(K, aspect, near, captureFit = 'height') {
  if (captureFit !== 'cover') return (2 * Math.atan(K.height / (2 * K.fy)) * 180) / Math.PI;
  const w = captureWindow(K, aspect, near, captureFit);
  // Symmetric-equivalent angle of an off-axis window: what `verticalFov` means on the wire.
  return (2 * Math.atan((w.top - w.bottom) / (2 * near)) * 180) / Math.PI;
}

/**
 * Can the PlayCanvas engine read this source — decidable WITHOUT loading anything? Returns a
 * reason string when it provably cannot (so ./splat can throw at call time), null when it can or
 * when that is only knowable later (a Blob, a URL with no extension).
 */
export function playcanvasCannotRead(src, { fileType, fileName } = {}) {
  let bytes = null;
  if (src instanceof Uint8Array) bytes = src;
  else if (src instanceof ArrayBuffer) bytes = new Uint8Array(src, 0, Math.min(8, src.byteLength));
  if (typeof src !== 'string' && !bytes && fileType === undefined) return null; // a Blob: known at load
  if (typeof src === 'string' && fileType === undefined && !extOf(src)) return null;
  if (engineFormatFor(typeof src === 'string' ? src : null, bytes, fileName, fileType)) return null;
  const what = fileType ?? (typeof src === 'string' ? `.${extOf(src)}` : 'these bytes');
  return (
    `the PlayCanvas engine (the default) reads .sog, .ply and a Streamed-SOG lod-meta.json, not ` +
    `${what}. Pass engine:'spark' for .spz / .splat / .ksplat / .rad.`
  );
}

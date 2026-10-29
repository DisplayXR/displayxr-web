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

import { comfortDepthFactor, isComfortZone, DEPTH_DEFAULT_VIEWER_M } from './inline3d-depth-budget.js';

/**
 * Double-attach detection around a scene subpath's public entry (`addSplat`, `addModel`).
 *
 * The check has to run HERE, at the entry, and not only in the core's addScene: the subpaths build
 * a renderer on the canvas BEFORE the core window exists (asynchronously, once the engine module
 * has loaded), so a second `addSplat` during the first one's load would never reach the core's
 * check in time. `wall._attachGuard` (the core manager) warns once per canvas and claims it; the
 * call then proceeds exactly as before. A wall without it (no session, an older core) attaches as is.
 */
export function guardedAttach(wall, canvas, method, opts, attach) {
  const g = wall && typeof wall._attachGuard === 'function' ? wall._attachGuard(canvas, method, opts) : null;
  if (!g) return attach(opts);
  const out = attach(g.opts);
  g.own(out);
  return out;
}

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
  if (isStreamedUrl(src)) return { ext: 'json', streamed: true };
  const e = extOf(src);
  if (e === 'sog' || e === 'ply') return { ext: e, streamed: false };
  if (e === 'json') return { ext: 'json', streamed: false };
  return null;
}

/**
 * Is this URL a Streamed SOG? Either its `lod-meta.json` or the DIRECTORY that holds one (a path
 * ending in `/`), with or without a query or hash. Here, not in the adapter, because both engines
 * need the answer synchronously: the PlayCanvas backend streams it, and the Spark path must refuse
 * it by name (Spark has no reader for it).
 */
export function isStreamedUrl(src) {
  if (typeof src !== 'string') return false;
  const p = pathOf(src);
  return /(^|\/)lod-meta\.json$/i.test(p) || (p.length > 0 && p.endsWith('/'));
}

/** The error a Spark page gets for a Streamed SOG URL. */
export const STREAMED_NEEDS_PLAYCANVAS =
  "a Streamed SOG (lod-meta.json) is read only by engine:'playcanvas' (the default); Spark has no " +
  'reader for it. Drop engine:\'spark\', or load a flat .sog.';

/**
 * A Streamed SOG handed over as BYTES — refuse it, with the reason. A Streamed SOG is a
 * directory: `lod-meta.json` names hundreds of chunk files by RELATIVE path, and bytes carry no
 * base URL to resolve them against. Detected by the file name the caller gave (`fileName`), or by
 * sniffing a JSON object that has the lod-meta keys (`lodLevels` + `filenames`) in its first 4 KB.
 *
 * @returns {string|null} the error message, or null when the bytes are not a lod-meta.
 */
export function streamedBytesError(bytes, fileName) {
  let hit = typeof fileName === 'string' && /(^|\/)lod-meta\.json$/i.test(pathOf(fileName));
  if (!hit && bytes && bytes.length) {
    let i = 0;
    while (i < bytes.length && i < 64 && (bytes[i] === 0x20 || bytes[i] === 0x0a || bytes[i] === 0x0d || bytes[i] === 0x09 || bytes[i] === 0xef || bytes[i] === 0xbb || bytes[i] === 0xbf)) i++;
    if (bytes[i] === 0x7b) {
      const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
      hit = /"lodLevels"\s*:/.test(head) && /"filenames"\s*:/.test(head);
    }
  }
  if (!hit) return null;
  return (
    'a Streamed SOG (lod-meta.json) cannot be passed as bytes: it is a directory of chunk files ' +
    'that lod-meta.json names by relative path, and bytes have no base URL to resolve them ' +
    "against. Pass its URL instead — addSplat(wall, canvas, 'https://…/scene/lod-meta.json') " +
    "(a URL ending in '/' works too)."
  );
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

// ── ZOOM: bounds + relax (the PlayCanvas backend's `zoom` option) ───────────────────────────

/** Wheel "release": this long with no wheel event ends the gesture and starts the relax, ms. */
export const ZOOM_WHEEL_IDLE_MS = 150;
/**
 * The zoom relax's landing floor, log-zoom per second. The relax is the orbit's exponential
 * (τ = 0.6 s), except it never moves slower than this, so it lands in finite time: from 2× the
 * exponential carries it to 1.5 % from home in ≈2.3 s and the floor finishes in ≈0.6 s more.
 */
export const ZOOM_RELAX_MIN_RATE = 0.025;

/**
 * Validate + default the `zoom` option: `{ min, max, relax, ease }`.
 *
 * Defaults are today's behaviour — ZOOM_MIN..ZOOM_MAX, no relax. `relax: true` eases the zoom
 * back to its rest (1×, or the last setPose zoom) once the wheel has been idle
 * ZOOM_WHEEL_IDLE_MS or a pinch ends, with τ = `ease` (default ORBIT_TAU_REST_S, the orbit's
 * relax — the two gestures come home together).
 *
 * @returns {{min:number, max:number, relax:boolean, ease:number}}
 */
export function resolveZoomOption(zoom) {
  if (zoom === undefined || zoom === null) return { min: ZOOM_MIN, max: ZOOM_MAX, relax: false, ease: ORBIT_TAU_REST_S };
  if (typeof zoom !== 'object') {
    throw new Error(`@displayxr/inline3d/splat: zoom ${zoom} — expected { min, max, relax, ease }.`);
  }
  const num = (k, v, d) => {
    if (v === undefined) return d;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw new Error(`@displayxr/inline3d/splat: zoom.${k} ${v} — expected a positive number.`);
    }
    return v;
  };
  const min = num('min', zoom.min, ZOOM_MIN);
  const max = num('max', zoom.max, ZOOM_MAX);
  if (max < min) throw new Error(`@displayxr/inline3d/splat: zoom.max ${max} is below zoom.min ${min}.`);
  const ease = num('ease', zoom.ease, ORBIT_TAU_REST_S);
  if (zoom.relax !== undefined && typeof zoom.relax !== 'boolean') {
    throw new Error(`@displayxr/inline3d/splat: zoom.relax ${zoom.relax} — expected true or false.`);
  }
  return { min, max, relax: zoom.relax === true, ease };
}

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
  else if (src instanceof ArrayBuffer) bytes = new Uint8Array(src, 0, Math.min(4096, src.byteLength));
  if (bytes) {
    const streamed = streamedBytesError(bytes, fileName);
    if (streamed) return streamed;
  }
  if (typeof src !== 'string' && !bytes && fileType === undefined) return null; // a Blob: known at load
  if (typeof src === 'string' && fileType === undefined && !extOf(src)) return null;
  if (engineFormatFor(typeof src === 'string' ? src : null, bytes, fileName, fileType)) return null;
  const what = fileType ?? (typeof src === 'string' ? `.${extOf(src)}` : 'these bytes');
  return (
    `the PlayCanvas engine (the default) reads .sog, .ply and a Streamed-SOG lod-meta.json, not ` +
    `${what}. Pass engine:'spark' for .spz / .splat / .ksplat / .rad.`
  );
}

// ── controls:'page' — the page drives the camera (docs/playcanvas-adapter.md §controls:'page') ──

/** Who owns the camera: the SDK's viewer (orbit, idle, fit, focus gestures) or the page. */
export const SPLAT_CONTROLS = Object.freeze(['viewer', 'page']);

/**
 * `comfortDepth` default — the auto-3D shim's `depth`, so a game on `controls:'page'` gets the
 * same stereo as the same game under the shim. It is the runtime's comfort number
 * `ipd × metersToVirtual × convergenceDiopters × 0.5`, which the rig below makes equal to it by
 * construction (`metersToVirtual = comfortDepth · d / 0.5`, `convergenceDiopters = 1 / d`).
 */
export const PAGE_COMFORT_DEPTH = 0.3;

/**
 * Options that mean nothing when the page owns the camera. Passing one is not an error (a page
 * switching an existing call site over should not have to prune it first); it is named ONCE in a
 * console.info line and ignored.
 */
export const PAGE_IGNORED_OPTIONS = Object.freeze([
  'fit',
  'virtualDisplayHeight',
  'orbit',
  'idleSpin',
  'focusInput',
  'margin',
  'fitSweep',
  'depthLimit',
  'orbitMaxDeg',
  'orbitEase',
  'zoom',
  'captureFit',
]);

/**
 * Validate the `controls` family at CALL time (both engines call this before anything loads).
 *
 * @returns {{page:boolean, comfortDepth:number, ignored:string[]}}
 * @throws on an unknown `controls`, a `comfortDepth` outside (0, 1], or `rig:'display'` with
 *         `controls:'page'` (the page's camera IS the rig; a display rig has no camera).
 */
export function resolveControls(opts = {}) {
  const controls = opts.controls ?? 'viewer';
  if (!SPLAT_CONTROLS.includes(controls)) {
    throw new Error(
      `@displayxr/inline3d/splat: controls "${controls}" — expected ` +
        `${SPLAT_CONTROLS.map((c) => `'${c}'`).join(' or ')} (default 'viewer').`,
    );
  }
  const page = controls === 'page';
  let comfortDepth = PAGE_COMFORT_DEPTH;
  if (opts.comfortDepth !== undefined) {
    const c = opts.comfortDepth;
    if (typeof c !== 'number' || !Number.isFinite(c) || c <= 0 || c > 1) {
      throw new Error(
        `@displayxr/inline3d/splat: comfortDepth ${c} — expected a number in (0, 1] ` +
          `(the runtime's comfort rule caps it at 1; the default is ${PAGE_COMFORT_DEPTH}).`,
      );
    }
    comfortDepth = c;
  }
  if (page && opts.rig === 'display') {
    throw new Error(
      "@displayxr/inline3d/splat: controls:'page' with rig:'display' — the page's camera IS the " +
        "rig, so it is always a camera rig. Drop `rig`, or use the default controls for a display rig.",
    );
  }
  if (opts.onBeforeFrame !== undefined) {
    if (typeof opts.onBeforeFrame !== 'function') {
      throw new Error('@displayxr/inline3d/splat: onBeforeFrame must be a function (frame) => void.');
    }
    if (!page) {
      throw new Error(
        "@displayxr/inline3d/splat: onBeforeFrame needs controls:'page' — with the default controls " +
          'the SDK owns the camera and there is no page pose to set before the draw.',
      );
    }
  }
  const ignored = page ? PAGE_IGNORED_OPTIONS.filter((k) => opts[k] !== undefined) : [];
  return { page, comfortDepth, ignored };
}

/**
 * Validate one `setCameraPose(matrixWorld, o)` call and return a private copy (the page may
 * reuse its arrays). Throws synchronously on a malformed call: a NaN in a camera matrix is a page
 * bug that would otherwise render nothing, silently.
 *
 * @returns {{matrixWorld:Float64Array, verticalFovDeg:number, near:number, far:number,
 *            convergence:number|null}}
 */
export function normalizeCameraPose(matrixWorld, o = {}) {
  const bad = (why) => new Error(`@displayxr/inline3d/splat: setCameraPose — ${why}`);
  if (!matrixWorld || typeof matrixWorld.length !== 'number' || matrixWorld.length !== 16) {
    throw bad('matrixWorld must be 16 numbers, column-major (a Float32Array(16) or an array).');
  }
  const m = new Float64Array(16);
  for (let i = 0; i < 16; i++) {
    const v = matrixWorld[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(`matrixWorld[${i}] is ${v}, not a finite number.`);
    m[i] = v;
  }
  const det =
    m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
  if (!(det > 1e-12)) {
    throw bad(`matrixWorld is singular or mirrored (det ${det.toPrecision(3)}); a camera pose is a rotation, a translation and at most a uniform scale.`);
  }
  const fov = o.verticalFovDeg;
  if (typeof fov !== 'number' || !(fov > 0 && fov < 180)) {
    throw bad(`verticalFovDeg ${fov} — the FULL vertical angle in degrees, in (0, 180).`);
  }
  const near = o.near === undefined ? MONO_NEAR : o.near;
  const far = o.far === undefined ? CAPTURE_FAR : o.far;
  if (typeof near !== 'number' || !(near > 0) || !Number.isFinite(near)) throw bad(`near ${near} — expected a finite number > 0.`);
  if (typeof far !== 'number' || !(far > near) || !Number.isFinite(far)) throw bad(`far ${far} — expected a finite number > near.`);
  let convergence = null;
  if (o.convergence !== undefined && o.convergence !== null) {
    const c = o.convergence;
    if (typeof c !== 'number' || !(c > 0) || !Number.isFinite(c)) throw bad(`convergence ${c} — metres along the view axis, > 0 (omit it for the adapter's own).`);
    convergence = c;
  }
  return { matrixWorld: m, verticalFovDeg: fov, near, far, convergence };
}

// ── coverage-linear alpha (setSource's crossfade, the `fade` effect) ────────────────────────────

/**
 * Nominal optical depth of a dense photo's splat stack, per pixel: −ln(transmittance) through the
 * whole stack at rest. The remap below is exact for a pixel of optical depth `L`. Real pictures
 * spread widely around any single value (measured 13–25 on SHARP photos), which is why the
 * crossfade blends IMAGES (FRAME_SNAPSHOT in ./inline3d-splat-playcanvas.js) and uses this only
 * to shape ramps — never as the thing that makes a fade linear.
 */
export const FADE_OPTICAL_DEPTH = 3;

/**
 * Smallest per-splat transmittance the remap works from. A fully opaque splat (SOG alpha 255/255
 * decodes to exactly 1, common in photos) has transmittance 0, and 0^k is 0 for every k > 0 — so
 * without a floor it could never fade at all. 0.02 caps one splat's optical depth at ~3.9.
 */
export const FADE_TRANSMITTANCE_FLOOR = 0.02;

/**
 * The per-splat alpha exponent `k` that puts a stack of nominal optical depth `L` at screen
 * coverage `c` (0..1).
 *
 * Scaling every splat's alpha by `c` saturates: a pixel under n near-opaque splats is covered
 * `1 − (1 − c·α)^n`. Raising each splat's transmittance to a power instead, `α' = 1 − (1 − α)^k`,
 * multiplies the stack's optical depth by k: coverage is `1 − e^{−kL}`. Solving for coverage =
 * c·(1 − e^{−L}) gives this k. Exact ends: k(0) = 0 (α' = 0, invisible) and k(1) = 1 (untouched).
 */
export function coverageExponent(c, L = FADE_OPTICAL_DEPTH) {
  if (!(c > 0)) return 0;
  if (c >= 1) return 1;
  return -Math.log(1 - c * (1 - Math.exp(-L))) / L;
}

// ── view-rig declaration (all three backends) ────────────────────────────────────────────────

let warnedNoViewRig = false;

/**
 * Declare a view rig on the scene handle. A handle without `setViewRig` is a core that predates
 * view rigs (inline3d.js before the view-rig commit — e.g. a page that vendors an older core and
 * hands its wall to this adapter): the rig cannot reach the browser, and the wall weaves on the
 * addScene display-rig shorthand instead. For a CAMERA rig that is a metric photo scene on a
 * 0.24 m display rig — convergence and scale way off while 2D looks right — so it is said out
 * loud, once per page, rather than dropped the way `handle?.setViewRig?.()` used to drop it.
 * Returns whether the handle took the rig.
 */
export function declareViewRig(handle, rig) {
  if (!handle) return false; // no wall (mono): nothing to declare to
  if (typeof handle.setViewRig === 'function') {
    handle.setViewRig(rig);
    return true;
  }
  if (rig?.type === 'camera' && !warnedNoViewRig) {
    warnedNoViewRig = true;
    console.warn(
      '[inline3d/splat] the view rig was dropped: your inline3d core predates view rigs (its ' +
        'addScene handle has no setViewRig), so the wall will use the addScene display-rig ' +
        'shorthand, not this camera rig — the scene will be mis-converged and mis-scaled in 3D. ' +
        'Update the core (js/inline3d.js) that created the wall to the same SDK version as ./splat.',
      rig,
    );
  }
  return false;
}

/**
 * The `clearColor` option of SceneViewer / addModel / addSplat, as `[r, g, b, a]` in 0..1 — or
 * null when absent (the viewer then keeps its transparent clear, exactly as before). Takes
 * `[r, g, b]` / `[r, g, b, a]` (0..1; alpha defaults to 1) or a CSS colour string: `#rgb`,
 * `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` / `rgba()` (comma or space syntax, `/ alpha`),
 * `transparent`, and — where a DOM is present — any other CSS colour the browser can parse.
 * Something it cannot read warns once per call (with `tag`) and returns null: the default clear
 * stays.
 */
export function parseClearColor(v, tag = '[inline3d]') {
  if (v === undefined || v === null) return null;
  const bad = () => {
    console.warn(`${tag} clearColor ${JSON.stringify(v)} is not a colour this SDK can read ([r,g,b,a] in 0..1, or a CSS colour); the default (transparent) clear is kept.`);
    return null;
  };
  if (Array.isArray(v) || ArrayBuffer.isView(v)) {
    if (v.length < 3 || v.length > 4) return bad();
    const c = [v[0], v[1], v[2], v.length === 4 ? v[3] : 1];
    if (!c.every((x) => typeof x === 'number' && Number.isFinite(x))) return bad();
    return c.map((x) => clamp(x, 0, 1));
  }
  if (typeof v !== 'string') return bad();
  const s = v.trim().toLowerCase();
  if (s === 'transparent') return [0, 0, 0, 0];
  let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((ch) => ch + ch).join('');
    const n = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
    return [n(0), n(2), n(4), h.length === 8 ? n(6) : 1];
  }
  m = /^rgba?\(\s*([^)]*)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(/\s*[,/]\s*|\s+/).filter(Boolean);
    if (parts.length < 3 || parts.length > 4) return bad();
    const ch = (p) => (p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p) / 255);
    const al = (p) => (p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p));
    const c = [ch(parts[0]), ch(parts[1]), ch(parts[2]), parts.length === 4 ? al(parts[3]) : 1];
    if (!c.every(Number.isFinite)) return bad();
    return c.map((x) => clamp(x, 0, 1));
  }
  // Any other CSS colour (a name, hsl(), …): let the browser normalise it, where there is one.
  // A 2D context's fillStyle reads back as #rrggbb or rgba(…), both handled above.
  try {
    const ctx = globalThis.document?.createElement?.('canvas')?.getContext?.('2d');
    if (ctx) {
      ctx.fillStyle = '#010203';
      ctx.fillStyle = v;
      const out = String(ctx.fillStyle);
      if (out !== '#010203') return parseClearColor(out, tag);
    }
  } catch {
    /* no DOM */
  }
  return bad();
}

/**
 * `handle.setStereo`'s argument, validated and merged onto the current override (throws at the
 * call). Returns the new override, or null when nothing is overridden. Shared by `./splat`
 * (PlayCanvas) and `./model` (both engines); `tag` names the subpath in the errors.
 */
export function validateSetStereo(o, prev, tag = '@displayxr/inline3d/splat') {
  if (o === null) return null;
  if (typeof o !== 'object') throw new TypeError(`${tag}: setStereo takes an object or null.`);
  // Absolute (…Factor) or RELATIVE to the asset's own (…Scale); per scalar, the last one given wins.
  const pairs = [
    ['ipdFactor', 'ipdScale'],
    ['parallaxFactor', 'parallaxScale'],
  ];
  const keys = pairs.flat();
  const unknown = Object.keys(o).filter((k) => !keys.includes(k));
  if (unknown.length) throw new Error(`${tag}: setStereo — unknown option(s) ${unknown.join(', ')}.`);
  for (const [a, b] of pairs) {
    if (o[a] != null && o[b] != null) throw new Error(`${tag}: setStereo — ${a} and ${b} are exclusive.`);
  }
  const next = { ...(prev || {}) };
  for (const [a, b] of pairs) {
    for (const k of [a, b]) {
      if (!(k in o) || o[k] === undefined) continue;
      if (o[k] === null) {
        delete next[k];
        continue;
      }
      if (typeof o[k] !== 'number' || !Number.isFinite(o[k]) || o[k] < 0) {
        throw new RangeError(`${tag}: setStereo — ${k} must be a finite number >= 0 (got ${o[k]}).`);
      }
      next[k] = o[k];
      delete next[k === a ? b : a];
    }
  }
  return Object.keys(next).length ? next : null;
}

/** One scalar under a setStereo override: its absolute value, else `base` × its scale, else `base`. */
export function stereoScalarOf(o, base, k) {
  if (o?.[`${k}Factor`] != null) return o[`${k}Factor`];
  if (o?.[`${k}Scale`] != null) return base * o[`${k}Scale`];
  return base;
}

/**
 * `./model`'s `handle.setStereo` + `handle.rig`, for both engines: `out` the model handle,
 * `getTile()` the core window handle (null without a session), `vH` the tile's
 * virtualDisplayHeight, `makeDisplayRig` ./three's displayRig. A model has no stereo of its own,
 * so the "asset's own" values are 1 and 1 — `ipdScale` and `ipdFactor` agree.
 *
 * The rig is the display rig addModel declared with its `virtualDisplayHeight` shorthand; a value
 * set here re-declares it as an explicit display rig with those factors (RELATIVE: 1 = what the
 * display shows by construction). `setStereo(null)` declares the plain rig again — the exact
 * equivalent of the shorthand. Nothing is sent before the first call: a page that never calls it
 * declares exactly what it did before. Under `controls: 'page'` the camera rig the page drives
 * takes the values instead, from its next tick.
 *
 * `setBase(k)` is the `depth` option's comfort factor: both scalars × k, on top of setStereo's,
 * declared like a setStereo call (and, like one, nothing until it is called with k ≠ 1).
 */
export function attachModelStereo(out, { getTile, vH, makeDisplayRig, page = false, tag = '@displayxr/inline3d/model' }) {
  let override = null;
  let declared = false;
  // The `depth` option's comfort factor (attachComfortDepth), multiplied under setStereo's values;
  // 1 = nothing to declare on its account.
  let base = 1;
  // controls:'page' declares its own camera rig every tick and reads rig.ipdFactor / parallaxFactor
  // there (ABSOLUTE on a camera rig, as addSplat's); nothing is declared from here.
  const rig = { type: page ? 'camera' : 'display', ipdFactor: 1, parallaxFactor: 1, stereoDefault: Object.freeze({ ipdFactor: 1, parallaxFactor: 1 }) };
  out.rig = rig;
  const declare = () => {
    const tile = getTile();
    if (page || !tile || (!override && !declared && base === 1)) return;
    declared = true;
    out.viewRig = makeDisplayRig({ virtualDisplayHeight: vH, ipdFactor: rig.ipdFactor, parallaxFactor: rig.parallaxFactor, out: out.viewRig || {} });
    declareViewRig(tile, out.viewRig);
  };
  const factors = () => {
    rig.ipdFactor = stereoScalarOf(override, 1, 'ipd') * base;
    rig.parallaxFactor = stereoScalarOf(override, 1, 'parallax') * base;
  };
  out.setStereo = (o) => {
    override = validateSetStereo(o, override, tag);
    factors();
    declare();
    return out;
  };
  return {
    redeclare: declare,
    get override() {
      return override;
    },
    /** The comfort factor (both scalars move together), × setStereo's; re-declares when it changes. */
    setBase(k) {
      if (k === base) return;
      base = k;
      factors();
      declare();
    },
  };
}

// ── the `depth` option: comfort depth (./model, ./splat) ──────────────────────────────────────

/**
 * addModel / addSplat's `depth` option, validated (throws at the call, like every option check):
 * null when absent — nothing about the tile changes — else `{ zone }`. `'auto'` is the Shibata
 * zone; `{ zone }` takes `'shibata'`, `'percival'` or a number of diopters > 0.
 */
export function resolveDepthOption(v, tag = '@displayxr/inline3d/splat') {
  if (v === undefined || v === null) return null;
  if (v === 'auto') return { zone: 'shibata' };
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new TypeError(`${tag}: depth must be 'auto' or { zone } (got ${JSON.stringify(v)}).`);
  }
  const unknown = Object.keys(v).filter((k) => k !== 'zone');
  if (unknown.length) throw new Error(`${tag}: depth — unknown option(s) ${unknown.join(', ')}.`);
  const zone = v.zone === undefined ? 'shibata' : v.zone;
  if (!isComfortZone(zone)) {
    throw new RangeError(`${tag}: depth.zone must be 'shibata', 'percival' or a number of diopters > 0 (got ${JSON.stringify(v.zone)}).`);
  }
  return { zone };
}

/**
 * The subject's depth AS FRAMED — getSubjectBounds' `front` / `back` at zoom 1 with no orbit
 * (the fit scale, the subject's half depth, the page's depthOffset). Zoom and orbit are left out
 * on purpose: they are framing choices the viewer (or the page) makes live, and the `depth`
 * option's factor must not breathe with them. Either viewer (SceneViewer, PlayCanvasSplatViewer).
 */
export function framedSubjectBounds(viewer) {
  const s = viewer._fitScale;
  const hz = viewer._subjectHalf?.[2];
  const cz = viewer._depthOffset || 0;
  if (!(s > 0) || !Number.isFinite(hz)) return null;
  return { front: cz + s * hz, back: cz - s * hz };
}

/**
 * The `depth` option's live part, shared by every engine: measure the comfort factor
 * (comfortDepthFactor) from the framed subject, the canvas's physical height and the NOMINAL viewer
 * distance, and hand it to `apply(k)` — the engine multiplies it into the display rig it declares,
 * on top of setStereo's values. `out.depthFactor` reads it (1 when the option is off or not in
 * force).
 *
 * Re-measured when the engine calls `refresh()` (after it frames a subject), when the tile first
 * weaves (its layer can answer getDisplayInfo from then), on a display event and when the canvas
 * resizes — never per frame, and never on zoom or orbit (the box is framedSubjectBounds'). `apply` runs only when k changes. `ignore(why)` says once that the
 * option does nothing on this rig (a camera rig, controls:'page') and holds the factor at 1;
 * `resume()` measures again (a PlayCanvas splat back on a display rig).
 * Without the option every method is a no-op: no listener, no observer, no async work.
 *
 * `getBounds()` → a framedSubjectBounds() box or null (null = nothing to measure now), `getVH()` →
 * the virtualDisplayHeight that box is in, `getTile()` → the core window handle.
 */
export function attachComfortDepth(out, { option, canvas, getTile, getBounds, getVH, apply, tag = '[inline3d]' }) {
  let factor = 1;
  Object.defineProperty(out, 'depthFactor', { get: () => factor, enumerable: true, configurable: true });
  if (!option) return { refresh() {}, ignore() {}, resume() {}, dispose() {}, get factor() { return 1; } };
  let ignoring = false;
  let warned = false;
  let disposed = false;
  let running = false;
  let again = false;
  let bound = null;
  const unbind = [];
  const bind = (tile) => {
    if (bound === tile) return;
    bound = tile;
    tile.firstWoven?.then?.(() => refresh(), () => {});
    for (const type of ['renderingmodechange', 'hardwaredisplaystatechange']) {
      try {
        const off = tile.on?.(type, () => refresh());
        if (typeof off === 'function') unbind.push(off);
      } catch {
        /* a core without display events: resize and refresh() still re-measure */
      }
    }
    if (canvas && typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => refresh());
      ro.observe(canvas);
      unbind.push(() => ro.disconnect());
    }
  };
  async function refresh() {
    if (disposed || ignoring) return;
    const tile = getTile();
    if (!tile || typeof tile.displayMetrics !== 'function') return;
    bind(tile);
    // One measurement at a time; a request during one runs once more after it (a resize burst).
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        let m = null;
        try {
          m = await tile.displayMetrics(); // never rejects; guarded for an older core
        } catch {
          m = null;
        }
        if (disposed || ignoring) return;
        const b = getBounds();
        const vH = getVH();
        if (!m || !b || !(vH > 0)) continue;
        const k = comfortDepthFactor({
          frontH: Math.max(0, b.front / vH),
          backH: Math.max(0, -b.back / vH),
          tileHeightM: m.canvasSizeM?.[1],
          // The NOMINAL distance (what the display is built for), never the live head: depth that
          // breathed with the viewer's head would be a second, unasked-for parallax.
          viewerM: m.source?.viewer === 'display' ? m.nominalViewerM : DEPTH_DEFAULT_VIEWER_M,
          zone: option.zone,
        });
        if (k !== factor) {
          factor = k;
          apply(k);
        }
      } while (again);
    } finally {
      running = false;
    }
  }
  return {
    refresh,
    /** This rig takes no comfort factor: say so once, and hold 1 (refresh() idle) until resume(). */
    ignore(why) {
      if (!warned) {
        warned = true;
        console.warn(`${tag} depth: 'auto' applies to the display rig only; ignored on ${why} (the rig is sent as declared).`);
      }
      ignoring = true;
      factor = 1;
    },
    /** A display rig again (PlayCanvas setRig / setSource): measure from here. */
    resume() {
      ignoring = false;
      return refresh();
    },
    dispose() {
      disposed = true;
      while (unbind.length) unbind.pop()();
    },
    get factor() {
      return factor;
    },
  };
}

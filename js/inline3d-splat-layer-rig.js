// inline3d-splat-layer-rig.js — handle.setLayerRig(): draw chosen PlayCanvas layers through the
// DISPLAY rig while the splat (and the runtime's declared rig) stay on the photo's CAMERA rig.
// Internal to ./inline3d-splat-playcanvas.js. Design: docs/proposals/layer-display-rig.md.
//
// NO KOOIMA HERE. The runtime's projection matrices are used verbatim; nothing below builds a
// frustum, a tangent or an off-axis matrix. What it does instead is an exact identity:
//
//   A camera rig is a portal: every view looks through ONE window rectangle on the convergence
//   plane (centre Wc = N0 + D·fwd), from its own eye E_i. The round (display-rig) views look
//   through the SAME window from E'_i = N0 + k·(E_i − N0) — the runtime's ipd/parallax factors
//   are linear about the nominal viewpoint, and the photo's camera rig is the display rig with
//   both factors at n/D (displayxr-common's rig conversion). Two portals through one window
//   differ only by the eye, and the affine shear M_i that fixes the window plane pointwise and
//   sends E'_i to E_i turns one picture into the other:
//
//       view_round_i = view_photo_i · M_i,     proj_round_i = proj_photo_i
//
// k = D / (m·n): D the declared convergence (world units), m the declared metersToVirtual, n the
// nominal viewer distance in metres — the one quantity the browser does not expose (see the
// design note §5). Everything here is PLAIN ARITHMETIC on arrays, unit-testable without a GPU.

import { invertAffine } from './inline3d-splat-rig-map.js';

/** handle.setLayerRig's rigs. 'camera' is the default every layer starts on. */
export const LAYER_RIGS = Object.freeze(['display', 'camera']);

/** Nominal viewer distance (m) when neither the page nor the platform says: the browser's own. */
export const DEFAULT_VIEWER_DISTANCE_M = 0.6;

/** A round eye may not reach the window plane: h(E') is floored at this fraction of D. */
const MIN_EYE_HEIGHT_FRAC = 1e-3;

/** Rotate v by unit quaternion q (xyzw). */
function rotate(q, v) {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/** The option keys setLayerRig / setLayerRigOptions take (the tile-wide rounding + plane). */
export const LAYER_RIG_OPTION_KEYS = Object.freeze(['viewerDistance', 'gain', 'planeOffset', 'planeDistance']);

/**
 * setLayerRig / setLayerRigOptions options, validated (throws at the call). Only the keys given
 * are returned: they MERGE into the tile's options. `null` clears a key (back to its default).
 *   viewerDistance  m, > 0     the nominal viewer distance n (default 0.6)
 *   gain            > 0        an explicit rounding gain k instead of D/(m·n)
 *   planeOffset     m, finite  moves the stage TOWARD the viewer by this much on the panel (display
 *                              space): the plane that lands on the glass moves back by offset·D/n
 *   planeDistance   > 0        the plane that lands on the glass, as a distance from the photo's
 *                              camera in world units (wins over planeOffset)
 */
export function validateLayerRigOptions(o = {}, who = 'setLayerRig') {
  if (o === null || typeof o !== 'object') throw new TypeError(`@displayxr/inline3d/splat: ${who} options must be an object.`);
  const unknown = Object.keys(o).filter((k) => !LAYER_RIG_OPTION_KEYS.includes(k));
  if (unknown.length) throw new Error(`@displayxr/inline3d/splat: ${who} — unknown option(s) ${unknown.join(', ')}; expected ${LAYER_RIG_OPTION_KEYS.join(', ')}.`);
  const out = {};
  for (const k of LAYER_RIG_OPTION_KEYS) {
    if (o[k] === undefined) continue;
    if (o[k] === null) {
      out[k] = null;
      continue;
    }
    const v = o[k];
    const ok = k === 'planeOffset' ? Number.isFinite(v) : Number.isFinite(v) && v > 0;
    if (!ok) throw new Error(`@displayxr/inline3d/splat: ${who} — bad ${k}: ${v}.`);
    out[k] = v;
  }
  return out;
}

/**
 * setLayerRig's arguments, validated (throws at the call).
 * @returns {{ rig: 'display'|'camera', opts: object }}
 */
export function validateLayerRig(layer, rig, o = {}) {
  if (!(typeof layer === 'string' && layer.length) && !(Number.isInteger(layer) && layer >= 0) && !(layer && typeof layer === 'object' && Number.isInteger(layer.id))) {
    throw new TypeError('@displayxr/inline3d/splat: setLayerRig(layer, …) — expected a layer name, a layer id, or a pc.Layer.');
  }
  if (!LAYER_RIGS.includes(rig)) {
    throw new Error(`@displayxr/inline3d/splat: setLayerRig — rig "${rig}", expected ${LAYER_RIGS.map((r) => `'${r}'`).join(' or ')}.`);
  }
  return { rig, opts: validateLayerRigOptions(o) };
}

/**
 * The frame of a declared CAMERA-rig descriptor (XRViewRigInit shape), or null for anything else
 * (a display rig, no rig, a convergence at infinity — no finite window to hold fixed).
 * @returns {{ N0: number[], fwd: number[], D: number, m: number }|null}
 */
export function cameraRigFrame(rig) {
  if (!rig || rig.type !== 'camera') return null;
  const inv = rig.convergenceDiopters;
  if (!Number.isFinite(inv) || !(inv > 0)) return null;
  const p = rig.position || { x: 0, y: 0, z: 0 };
  const o = rig.orientation || { x: 0, y: 0, z: 0, w: 1 };
  const m = Number.isFinite(rig.metersToVirtual) && rig.metersToVirtual > 0 ? rig.metersToVirtual : 1;
  const fwd = rotate([o.x || 0, o.y || 0, o.z || 0, o.w === undefined ? 1 : o.w], [0, 0, -1]);
  return { N0: [p.x || 0, p.y || 0, p.z || 0], fwd, D: 1 / inv, m };
}

/** k = D / (m·n), or the caller's explicit gain. */
export function layerRigGain(frame, { viewerDistance = null, gain = null } = {}) {
  if (gain !== null && gain !== undefined) return gain;
  const n = viewerDistance !== null && viewerDistance !== undefined ? viewerDistance : DEFAULT_VIEWER_DISTANCE_M;
  return frame.D / (frame.m * n);
}

/**
 * The plane that lands on the GLASS, as a distance from the photo's camera (world units): the
 * convergence distance D by default; `planeDistance` if given; else D·(1 + planeOffset/n) — a
 * stage moved toward the viewer by `planeOffset` metres on the panel (near the plane the round rig
 * maps world depth to panel depth at n/D). Always > 0.
 */
export function layerRigPlane(frame, { viewerDistance = null, planeOffset = null, planeDistance = null } = {}) {
  if (planeDistance !== null && planeDistance !== undefined) return planeDistance;
  if (planeOffset === null || planeOffset === undefined || planeOffset === 0) return frame.D;
  const n = viewerDistance !== null && viewerDistance !== undefined ? viewerDistance : DEFAULT_VIEWER_DISTANCE_M;
  return Math.max(frame.D * 1e-3, frame.D * (1 + planeOffset / n));
}

/**
 * The window-fixing shear for one eye, as a column-major 4×4 (and its inverse), in the space the
 * declared rig and the views share.
 *
 *   M(X) = X + v · (ẑ·X − c),   ẑ = −fwd,  c = ẑ·Wc,  v = (E − E') / h(E'),  h(X) = ẑ·X − c
 *   M⁻¹  = the same form with v' = −v / (1 + ẑ·v)
 *
 * @param {number[]} E  the runtime's eye position (the view pose's translation).
 * @returns {{ M: Float64Array, Minv: Float64Array, Eround: number[] }}
 */
export function windowShear(E, frame, k, M = new Float64Array(16), Minv = new Float64Array(16)) {
  const { N0, fwd, D } = frame;
  const z = [-fwd[0], -fwd[1], -fwd[2]];
  const Wc = [N0[0] + D * fwd[0], N0[1] + D * fwd[1], N0[2] + D * fwd[2]];
  const c = z[0] * Wc[0] + z[1] * Wc[1] + z[2] * Wc[2];
  const Er = [N0[0] + k * (E[0] - N0[0]), N0[1] + k * (E[1] - N0[1]), N0[2] + k * (E[2] - N0[2])];
  let h = z[0] * Er[0] + z[1] * Er[1] + z[2] * Er[2] - c;
  const hMin = MIN_EYE_HEIGHT_FRAC * D;
  if (!(h > hMin)) {
    // Leaning into the glass with a large gain: keep the round eye in front of the window.
    const dh = hMin - h;
    Er[0] += dh * z[0];
    Er[1] += dh * z[1];
    Er[2] += dh * z[2];
    h = hMin;
  }
  const v = [(E[0] - Er[0]) / h, (E[1] - Er[1]) / h, (E[2] - Er[2]) / h];
  shearMatrix(v, z, c, M);
  const s = 1 + z[0] * v[0] + z[1] * v[1] + z[2] * v[2];
  shearMatrix([-v[0] / s, -v[1] / s, -v[2] / s], z, c, Minv);
  return { M, Minv, Eround: Er };
}

/** X ↦ X + v·(z·X − c), column-major. */
function shearMatrix(v, z, c, out) {
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) out[col * 4 + row] = (row === col ? 1 : 0) + v[row] * z[col];
    out[col * 4 + 3] = 0;
  }
  out[12] = -v[0] * c;
  out[13] = -v[1] * c;
  out[14] = -v[2] * c;
  out[15] = 1;
  return out;
}

/** Unit quaternion (xyzw) of a rigid column-major 4×4's rotation. */
function quatOf(m) {
  const m11 = m[0], m12 = m[4], m13 = m[8], m21 = m[1], m22 = m[5], m23 = m[9], m31 = m[2], m32 = m[6], m33 = m[10];
  const tr = m11 + m22 + m33;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    return [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s];
  }
  if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    return [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s];
  }
  if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    return [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s];
  }
  const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
  return [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s];
}

/** a × b, column-major (local, so this module stays standalone). */
export function mul4(a, b, out = new Float64Array(16)) {
  const r = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      r[col * 4 + row] = a[row] * b[col * 4] + a[4 + row] * b[col * 4 + 1] + a[8 + row] * b[col * 4 + 2] + a[12 + row] * b[col * 4 + 3];
    }
  }
  out.set(r);
  return out;
}

/** Inverse of a rigid (rotation + translation) column-major 4×4. */
export function invertRigid(m, out = new Float64Array(16)) {
  const r = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  out[0] = r[0]; out[1] = r[3]; out[2] = r[6]; out[3] = 0;
  out[4] = r[1]; out[5] = r[4]; out[6] = r[7]; out[7] = 0;
  out[8] = r[2]; out[9] = r[5]; out[10] = r[8]; out[11] = 0;
  const tx = m[12], ty = m[13], tz = m[14];
  out[12] = -(out[0] * tx + out[4] * ty + out[8] * tz);
  out[13] = -(out[1] * tx + out[5] * ty + out[9] * tz);
  out[14] = -(out[2] * tx + out[6] * ty + out[10] * tz);
  out[15] = 1;
  return out;
}

/**
 * The round views for one frame: for each runtime view pose P_i (camera → rig space),
 * `viewInv = S⁻¹ · M_i⁻¹ · P_i` and `view = P_i⁻¹ · M_i · S` — what RenderView.setView takes.
 *
 * S is the uniform scale by σ = D / plane about the photo camera N0: it sends the plane that
 * should land on the glass (`plane`, a distance from N0) onto the photo's window plane, and every
 * ray from N0 onto itself — so at the nominal viewpoint the picture is unchanged and only the
 * depth that lands on the glass moves. Exact (a portal through the window at `plane`, seen from
 * N0 + k·D/plane·(E − N0) … mapped by S onto the photo's own portal). σ = 1 without an offset.
 *
 * Null (the caller keeps the photo views) when there is nothing to do: no camera rig, fewer than
 * two views, or a gain of exactly 1 with no plane offset.
 */
export function roundViews(entries, frame, k, into = [], plane = frame ? frame.D : 1) {
  const sigma = frame && plane > 0 ? frame.D / plane : 1;
  if (!frame || !entries || entries.length < 2 || !(k > 0) || (k === 1 && sigma === 1)) return null;
  into.length = entries.length;
  const S = scaleAbout(frame.N0, sigma);
  const Sinv = scaleAbout(frame.N0, 1 / sigma);
  for (let i = 0; i < entries.length; i++) {
    const P = entries[i].pose;
    const o = (into[i] ||= { viewInv: new Float64Array(16), view: new Float64Array(16), M: new Float64Array(16), Minv: new Float64Array(16), eye: [0, 0, 0] });
    const { Eround } = windowShear([P[12], P[13], P[14]], frame, k, o.M, o.Minv);
    // The virtual eye in rig space: S⁻¹(E′).
    for (let a = 0; a < 3; a++) o.eye[a] = frame.N0[a] + (Eround[a] - frame.N0[a]) / sigma;
    mul4(Sinv, mul4(o.Minv, P), o.viewInv);
    mul4(mul4(invertAffine(P), o.M), S, o.view); // P is rigid, or affine once remapped to the declared rig (./inline3d-splat-rig-map.js)
  }
  return into;
}

/** X ↦ C + s·(X − C), column-major. */
function scaleAbout(C, s, out = new Float64Array(16)) {
  out.fill(0);
  out[0] = out[5] = out[10] = s;
  out[12] = C[0] * (1 - s);
  out[13] = C[1] * (1 - s);
  out[14] = C[2] * (1 - s);
  out[15] = 1;
  return out;
}

/**
 * Split a layer composition into contiguous RUNS for per-rig cameras. `entries` is the
 * composition's sublayer list as layer ids, in draw order (opaque and transparent sublayers both
 * appear); `display` the set of display-rig layer ids; `eyeLayers` the ids the eye camera draws.
 * PlayCanvas orders render actions by CAMERA, then layer — so keeping today's order with a second
 * rig needs one camera per run:
 *   pre      — eye-camera layers with any sublayer before the first display sublayer (stay put);
 *   display  — the display layers the eye camera drew;
 *   post     — eye-camera layers whose every sublayer comes after the last display sublayer.
 * A non-display layer INTERLEAVED between display sublayers stays in `pre` (it would otherwise
 * split a run) and is reported in `interleaved`.
 */
export function layerRuns(entries, display, eyeLayers) {
  const eye = new Set(eyeLayers);
  let first = -1;
  let last = -1;
  for (let i = 0; i < entries.length; i++) {
    if (display.has(entries[i]) && eye.has(entries[i])) {
      if (first < 0) first = i;
      last = i;
    }
  }
  const out = { pre: [], display: [], post: [], interleaved: [] };
  if (first < 0) {
    out.pre = [...eye];
    return out;
  }
  const seen = new Set();
  for (const id of eyeLayers) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (display.has(id)) {
      out.display.push(id);
      continue;
    }
    const at = [];
    for (let i = 0; i < entries.length; i++) if (entries[i] === id) at.push(i);
    if (at.length && at.every((i) => i > last)) out.post.push(id);
    else {
      out.pre.push(id);
      if (at.some((i) => i > first && i < last)) out.interleaved.push(id);
    }
  }
  // Keep the run cameras' layer lists in draw order (the composition's, not the eye's list).
  const order = (ids) => ids.sort((a, b) => entries.indexOf(a) - entries.indexOf(b));
  order(out.display);
  order(out.post);
  return out;
}

// ── the engine side ──────────────────────────────────────────────────────────────────────────

/** How many state lines the layer rig may WARN per tile (first 3D frame + every change). */
const MAX_STATE_WARNS = 12;

/** Name of a camera component's entity, for a reason string. */
const camName = (c) => c?.entity?.name || c?.name || '(unnamed camera)';

/**
 * The per-rig cameras of one tile. Owned by the viewer; `sync` + `frame` are called by its draw,
 * on EVERY view path:
 *   renderviews — the eye camera draws N RenderViews; each run is ONE camera with N RenderViews.
 *   ncamera     — the fallback: one eye camera per view (rect + projection override); each run is
 *                 N cameras the same way, the display run's projections carrying the shear.
 * The eye camera(s) keep their `layers` minus what moved; `restore()` puts them back.
 */
export class LayerRigCameras {
  constructor(viewer) {
    this.viewer = viewer;
    /** What the page asked for: name or id → true. */
    this.requests = new Map();
    /** Those, resolved: layer id → the caller's key (the ones the eye camera draws right now). */
    this.layers = new Map();
    /** The tile's options: merged across setLayerRig / setLayerRigOptions calls. */
    this.opts = { viewerDistance: null, gain: null, planeOffset: null, planeDistance: null };
    this.disabled = false; // the kill switch (diag 'nolayerrig')
    this.cams = { display: [], post: [] };
    this.moved = { display: [], post: [] };
    this._key = '';
    this._rvs = { display: [], post: [] };
    this._round = [];
    this._syncReason = null;
    this._warns = 0;
    this._warnKey = '';
    /** What the last drawn frame did (layerRigState reads it). */
    this.last = { path: null, engaged: false, reason: 'no frame drawn yet', gain: null, planeM: null, views: 0, located: null, rounded: false };
  }

  get active() {
    return !this.disabled && this.requests.size > 0;
  }

  /** Resolve a name / id / pc.Layer to a layer of this tile's composition (null if unknown). */
  resolve(key) {
    const comp = this.viewer.app?.scene?.layers;
    if (!comp) return null;
    if (Number.isInteger(key)) return comp.getLayerById?.(key) || { id: key };
    return comp.getLayerByName?.(key) || null;
  }

  /** Record a request by the caller's key (name, id); resolved on every sync. */
  set(key, rig, o = {}) {
    const k = key && typeof key === 'object' ? key.id : key;
    if (rig === 'display') this.requests.set(k, true);
    else this.requests.delete(k);
    this.setOptions(o);
    this._key = ''; // re-split on the next draw
  }

  /** Merge options (validated by the caller): a key given replaces, `null` clears. */
  setOptions(o = {}) {
    for (const [k, v] of Object.entries(o)) this.opts[k] = v;
  }

  /** The eye camera entities of the current view path. */
  _eyeCams() {
    const v = this.viewer;
    if (v._viewPath === 'cameras') return (v._views || []).filter((c) => c?.camera);
    return v.eye?.camera ? [v.eye] : [];
  }

  _makeCam(name, priority) {
    const v = this.viewer;
    const cam = v._makeCamera(name, v._viewPath === 'cameras' && v.pc?.Vec4 ? new v.pc.Vec4(0, 0, 1, 1) : null);
    cam.camera.priority = priority;
    cam.camera.clearColorBuffer = false;
    cam.camera.clearDepthBuffer = false;
    cam.camera.clearStencilBuffer = false;
    cam.camera.frustumCulling = false;
    cam.camera.layers = [];
    cam._dxrLayerRig = true;
    if (v._viewPath === 'cameras') {
      cam._dxrProj = new Float64Array(16);
      cam.camera.calculateProjection = (out) => out.set(cam._dxrProj);
    }
    return cam;
  }

  /** Ensure `n` cameras for a run (1 on renderviews, one per view on ncamera). */
  _runCams(run, n, priority) {
    const list = this.cams[run];
    while (list.length < n) list.push(this._makeCam(`inline3d-eye-${run}${list.length ? `-${list.length}` : ''}`, priority));
    return list;
  }

  /**
   * Re-split the composition when the display set, the eye's layers or the composition moved.
   * Returns whether a display run exists; `_syncReason` says why not.
   */
  sync() {
    const v = this.viewer;
    const eyes = this._eyeCams();
    const comp = v.app?.scene?.layers;
    if (!this.active) {
      if (this.moved.display.length || this.moved.post.length) this.restore();
      this._syncReason = this.disabled ? 'kill switch (?dxrdiag=nolayerrig)' : 'no layer on the display rig';
      return false;
    }
    if (!eyes.length || !comp) {
      this._syncReason = 'engine not ready';
      return false;
    }
    const ref = eyes[0].camera;
    const eyeLayers = [...(ref.layers || []), ...this.moved.display, ...this.moved.post];
    const orphans = []; // display layers NO camera draws: ours to draw (nobody else can lose them)
    const entries = (comp.layerList || []).map((l) => l.id);
    // Resolve every request; a layer the eye camera does not draw cannot be moved (another camera
    // — the page's own, a reflection pass — draws it, or none does): say so, never silently.
    this.layers.clear();
    const missing = [];
    const foreign = [];
    for (const key of this.requests.keys()) {
      const layer = this.resolve(key);
      if (!layer) {
        missing.push(`"${key}" is not in the tile's layer composition`);
        continue;
      }
      if (!eyeLayers.includes(layer.id)) {
        const by = (layer.cameras || []).filter((c) => !c?.entity?._dxrLayerRig).map(camName);
        if (by.length) {
          // Another camera (the page's own, a reflection pass) draws it: taking it away could break
          // that camera's output, so it is left alone — and said.
          foreign.push(`"${key}" is drawn by ${by.join(', ')}, not by the tile's eye camera — draw it with handle.engine.camera (or pass it to setLayerRig without adding it to any camera)`);
          continue;
        }
        orphans.push(layer.id);
      }
      this.layers.set(layer.id, key);
    }
    const problems = [...missing, ...foreign];
    const key = `${eyes.length}|${[...this.layers.keys()].join(',')}|${entries.join(',')}|${(ref.layers || []).join(',')}|${problems.length}`;
    if (key !== this._key) {
      const runs = layerRuns(entries, new Set(this.layers.keys()), [...eyeLayers, ...orphans]);
      if (runs.interleaved.length && !this._warnedInterleaved) {
        this._warnedInterleaved = true;
        console.warn(
          `[inline3d/splat] setLayerRig: layer(s) ${runs.interleaved.join(', ')} sit BETWEEN display-rig ` +
            'sublayers; they are drawn before them (with the eye camera). Move them before or after the display layers.',
        );
      }
      this.moved.display = runs.display;
      this.moved.post = runs.post;
      for (const e of eyes) e.camera.layers = runs.pre.slice();
      this._runLayers = { display: runs.display, post: runs.post };
      this._key = `${eyes.length}|${[...this.layers.keys()].join(',')}|${entries.join(',')}|${runs.pre.join(',')}|${problems.length}`;
    }
    this._problems = problems;
    this._syncReason = this.moved.display.length ? null : problems.join('; ') || 'no display layer resolved';
    return this.moved.display.length > 0;
  }

  /** Every moved layer back on the eye camera(s), run cameras off (the kill switch / last layer off). */
  restore() {
    const back = [...this.moved.display, ...this.moved.post];
    for (const e of this._eyeCams()) {
      const cur = e.camera.layers || [];
      e.camera.layers = [...cur, ...back.filter((id) => !cur.includes(id))];
    }
    this.moved = { display: [], post: [] };
    for (const list of Object.values(this.cams)) for (const c of list) c.enabled = false;
    this._key = '';
  }

  /**
   * Per drawn frame, after the eye camera(s) are set up. `rig` is the descriptor the runtime
   * located these views with; `located` whether the views were VERIFIED against it (the rig map
   * read it off the views) — false means it is the SDK's own record, unverified. Records what
   * happened in `last` and WARNs one line on the first 3D frame and on every change.
   */
  frame(entries, rect, f, rig, { located = null, residual = null } = {}) {
    const v = this.viewer;
    const ncam = v._viewPath === 'cameras';
    const L = this.last;
    L.views = entries.length;
    L.path = entries.length < 2 ? 'mono' : ncam ? 'ncamera' : 'renderviews';
    L.located = located;
    L.residual = residual;
    const hasRun = this.sync();
    const frame = cameraRigFrame(rig);
    const k = frame ? layerRigGain(frame, this.opts) : null;
    const plane = frame ? layerRigPlane(frame, this.opts) : null;
    L.gain = k;
    L.planeM = plane;
    L.photoConvergenceM = frame ? frame.D : null;
    const round = hasRun && frame ? roundViews(entries, frame, k, this._round, plane) : null;
    let reason = null;
    if (!hasRun) reason = this._syncReason;
    else if (entries.length < 2) reason = 'mono (one view): nothing to round — identical to the photo rig';
    else if (!rig) reason = 'no declared view rig for these views';
    else if (!frame) reason = rig.type === 'camera' ? 'camera rig with no finite convergence' : `the declared rig is a ${rig.type || 'non-camera'} rig (setRig('display') / setVideo): already the display rig`;
    else if (!round) reason = 'gain 1 and no plane offset: identical to the photo rig';
    L.engaged = !!round;
    L.rounded = L.engaged;
    L.reason = reason || (this._problems?.length ? `engaged; ${this._problems.join('; ')}` : null);
    if (hasRun) {
      const nViews = entries.length;
      for (const run of ['display', 'post']) {
        const layers = this._runLayers?.[run] || [];
        const need = layers.length ? (ncam ? nViews : 1) : 0;
        const list = need ? this._runCams(run, need, run === 'display' ? 1 : 2) : this.cams[run];
        for (let c = 0; c < list.length; c++) {
          list[c].enabled = c < need;
          if (c < need) list[c].camera.layers = layers;
        }
        if (!need) continue;
        const r = run === 'display' ? round : null;
        if (ncam) this._frameNcam(list, entries, rect, r, run);
        else this._frameRenderViews(list[0], entries, rect, f, r, run);
        if (run === 'display') for (let c = 0; c < need; c++) list[c].camera.clearDepthBuffer = !!r; // two spaces never share a depth test
      }
    }
    this._warnState();
  }

  _frameRenderViews(cam, entries, rect, f, r, run) {
    const pc = this.viewer.pc;
    const rvs = this._rvs[run];
    if (rvs.length !== entries.length) {
      rvs.length = 0;
      for (let i = 0; i < entries.length; i++) rvs.push(new pc.RenderView());
      cam.camera.camera.xrViews = rvs.slice();
    }
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (r) rvs[i].setView(e.proj, r[i].viewInv, r[i].view);
      else rvs[i].setView(e.proj, e.pose);
      const [x, y, w, h] = rect(e);
      rvs[i].setViewport(x, y, w, h);
    }
    if (cam._frustumKey !== this.viewer._frustumKey) {
      cam._frustumKey = this.viewer._frustumKey;
      cam.camera.camera.setXrProperties({ ...f, horizontalFov: false });
    }
    // The node drives transparent sorting (the views ignore it): on the (round) first eye.
    const p = entries[0].node || entries[0].pose; // `node`: a rigid pose when the views are remapped
    const q = quatOf(p);
    cam.setLocalRotation(q[0], q[1], q[2], q[3]);
    if (r) cam.setLocalPosition(r[0].eye[0], r[0].eye[1], r[0].eye[2]);
    else cam.setLocalPosition(p[12], p[13], p[14]);
  }

  /**
   * The N-camera path, mirroring the viewer's own fallback: camera i at view i's rect, its node on
   * the view's rigid pose, and a projection override. The engine then draws with
   * proj' · node⁻¹ (node under the rig node), so the display run's shear rides in the projection:
   * proj' = proj · view_round · node  ⇒  proj' · node⁻¹ = proj · view_round. Culling is off on these
   * cameras (the sheared frustum is not the node's).
   */
  _frameNcam(list, entries, rect, r, run) {
    const v = this.viewer;
    const pc = v.pc;
    const el = v.canvas;
    const W = el?.width || 1;
    const H = el?.height || 1;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const cam = list[i];
      const node = e.node || e.pose;
      if (r) mul4(e.proj, mul4(r[i].view, node), cam._dxrProj);
      else if (e.node) mul4(e.proj, mul4(invertAffine(e.pose), node), cam._dxrProj);
      else cam._dxrProj.set(e.proj);
      const fr = v._frustumOf ? v._frustumOf(e.proj) : null;
      if (fr) {
        cam.camera.fov = fr.fov;
        cam.camera.nearClip = fr.nearClip;
        cam.camera.farClip = fr.farClip;
      }
      const [x, y, w, h] = rect(e);
      cam.camera.rect = pc?.Vec4 ? new pc.Vec4(x / W, y / H, w / W, h / H) : [x / W, y / H, w / W, h / H];
      const q = quatOf(node);
      cam.setLocalRotation(q[0], q[1], q[2], q[3]);
      cam.setLocalPosition(node[12], node[13], node[14]);
    }
  }

  /** One WARN line on the first 3D frame and on every change of engaged / reason / path. */
  _warnState() {
    const L = this.last;
    if (L.path === 'mono' && !this._warnedOnce3d) return; // wait for the first 3D frame
    if (!this.requests.size) return; // nothing asked for: nothing to report
    const key = `${L.path}|${L.engaged}|${L.reason}`;
    if (key === this._warnKey || this._warns >= MAX_STATE_WARNS) return;
    this._warnKey = key;
    this._warns++;
    if (L.path !== 'mono') this._warnedOnce3d = true;
    console.warn(`[inline3d/splat] setLayerRig: ${layerRigLine(this.state())}`);
  }

  /** The public state (handle.layerRigState). */
  state() {
    const L = this.last;
    return {
      display: [...this.requests.keys()],
      disabled: this.disabled,
      path: L.path,
      engaged: !!L.engaged,
      rounded: !!L.engaged,
      reason: this.disabled ? 'kill switch (?dxrdiag=nolayerrig)' : L.reason,
      viewerDistance: this.opts.viewerDistance ?? DEFAULT_VIEWER_DISTANCE_M,
      gain: L.gain,
      planeM: L.planeM,
      photoConvergenceM: L.photoConvergenceM ?? null,
      planeOffset: this.opts.planeOffset ?? 0,
      located: L.located,
    };
  }

  destroy() {
    this.restore();
    for (const list of Object.values(this.cams)) for (const c of list) c?.destroy?.();
    this.cams = { display: [], post: [] };
  }
}

/** layerRigState() as one console line (the WARN, and what a page's HUD can print). */
export function layerRigLine(st) {
  const n = (x, d = 3) => (x === null || x === undefined ? '-' : Number(x).toFixed(d));
  return (
    `path=${st.path ?? '-'} engaged=${st.engaged} layers=[${st.display.join(', ')}] ` +
    `viewerDistance=${n(st.viewerDistance, 2)}m gain=${n(st.gain)} planeM=${n(st.planeM)} ` +
    `photoConvergenceM=${n(st.photoConvergenceM)} planeOffset=${n(st.planeOffset)}m ` +
    `located=${st.located === null || st.located === undefined ? '-' : st.located} reason=${st.reason ?? '-'}`
  );
}

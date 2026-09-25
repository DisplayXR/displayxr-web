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

/**
 * setLayerRig's arguments, validated (throws at the call).
 * @returns {{ rig: 'display'|'camera', viewerDistance: number|null, gain: number|null }}
 */
export function validateLayerRig(layer, rig, o = {}) {
  if (!(typeof layer === 'string' && layer.length) && !(Number.isInteger(layer) && layer >= 0) && !(layer && typeof layer === 'object' && Number.isInteger(layer.id))) {
    throw new TypeError('@displayxr/inline3d/splat: setLayerRig(layer, …) — expected a layer name, a layer id, or a pc.Layer.');
  }
  if (!LAYER_RIGS.includes(rig)) {
    throw new Error(`@displayxr/inline3d/splat: setLayerRig — rig "${rig}", expected ${LAYER_RIGS.map((r) => `'${r}'`).join(' or ')}.`);
  }
  if (o === null || typeof o !== 'object') throw new TypeError('@displayxr/inline3d/splat: setLayerRig options must be an object.');
  const num = (k) => {
    if (o[k] === undefined) return null;
    if (!Number.isFinite(o[k]) || !(o[k] > 0)) throw new Error(`@displayxr/inline3d/splat: setLayerRig — bad ${k}: ${o[k]}.`);
    return o[k];
  };
  return { rig, viewerDistance: num('viewerDistance'), gain: num('gain') };
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
  if (gain !== null) return gain;
  const n = viewerDistance !== null ? viewerDistance : DEFAULT_VIEWER_DISTANCE_M;
  return frame.D / (frame.m * n);
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
 * The round views for one frame: for each runtime view pose P_i (camera → rig space, rigid),
 * `viewInv = M_i⁻¹ · P_i` and `view = P_i⁻¹ · M_i` — what RenderView.setView takes. Null (the
 * caller keeps the photo views) when there is nothing to round: no camera rig, fewer than two
 * views, or a gain of exactly 1.
 */
export function roundViews(entries, frame, k, into = []) {
  if (!frame || !entries || entries.length < 2 || !(k > 0) || k === 1) return null;
  into.length = entries.length;
  for (let i = 0; i < entries.length; i++) {
    const P = entries[i].pose;
    const o = (into[i] ||= { viewInv: new Float64Array(16), view: new Float64Array(16), M: new Float64Array(16), Minv: new Float64Array(16), eye: [0, 0, 0] });
    const { Eround } = windowShear([P[12], P[13], P[14]], frame, k, o.M, o.Minv);
    o.eye[0] = Eround[0];
    o.eye[1] = Eround[1];
    o.eye[2] = Eround[2];
    mul4(o.Minv, P, o.viewInv);
    mul4(invertAffine(P), o.M, o.view); // P is rigid, or affine once remapped to the declared rig (./inline3d-splat-rig-map.js)
  }
  return into;
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

/**
 * The per-rig cameras of one tile. Owned by the viewer; `sync` + `frame` are called by its draw.
 * The eye camera keeps its `layers` minus what moved; `restore()` puts them back.
 */
export class LayerRigCameras {
  constructor(viewer) {
    this.viewer = viewer;
    /** What the page asked for: name or id → { viewerDistance, gain }. */
    this.requests = new Map();
    /** Those, resolved: layer id → options (the ones present in the composition right now). */
    this.layers = new Map();
    /** The gain options in force (the last setLayerRig call's — one gain per tile). */
    this.opts = {};
    this.disabled = false; // the kill switch (diag 'nolayerrig')
    this.cams = { display: null, post: null };
    this.moved = { display: [], post: [] };
    this._key = '';
    this._rvs = { display: [], post: [] };
    this._round = [];
    /** Diagnostics: what the last frame did. */
    this.last = { rounded: false, gain: null, views: 0 };
  }

  get active() {
    return !this.disabled && this.requests.size > 0;
  }

  /** Resolve a name / id / pc.Layer to an id in this tile's composition (null if unknown). */
  resolve(layer) {
    const comp = this.viewer.app?.scene?.layers;
    if (!comp) return null;
    if (layer && typeof layer === 'object') return layer.id;
    if (Number.isInteger(layer)) return layer;
    const l = comp.getLayerByName?.(layer);
    return l ? l.id : null;
  }

  /**
   * Record a request by the caller's key (name, id): resolved against the composition on every
   * sync, so a layer the page adds AFTER calling setLayerRig is picked up when it appears.
   */
  set(key, rig, o) {
    const k = key && typeof key === 'object' ? key.id : key;
    if (rig === 'display') this.requests.set(k, o);
    else this.requests.delete(k);
    this.opts = o;
    this._key = ''; // re-split on the next draw
  }

  _resolveAll() {
    this.layers.clear();
    for (const [k, o] of this.requests) {
      const id = this.resolve(k);
      if (id !== null && id !== undefined) this.layers.set(id, o);
    }
  }

  _makeCam(name, priority) {
    const v = this.viewer;
    const cam = v._makeCamera(name, null);
    cam.camera.priority = priority;
    cam.camera.clearColorBuffer = false;
    cam.camera.clearDepthBuffer = false;
    cam.camera.clearStencilBuffer = false;
    cam.camera.frustumCulling = false;
    cam.camera.layers = [];
    return cam;
  }

  /** Re-split the composition when the display set, the eye's layers or the composition moved. */
  sync() {
    const v = this.viewer;
    const eyeCam = v.eye?.camera;
    const comp = v.app?.scene?.layers;
    if (!eyeCam || !comp) return false;
    if (!this.active) {
      if (this.moved.display.length || this.moved.post.length) this.restore();
      return false;
    }
    this._resolveAll();
    const entries = (comp.layerList || []).map((l) => l.id);
    const eyeLayers = [...(eyeCam.layers || []), ...this.moved.display, ...this.moved.post];
    const key = `${[...this.layers.keys()].join(',')}|${entries.join(',')}|${(eyeCam.layers || []).join(',')}`;
    if (key === this._key) return this.moved.display.length > 0;
    const runs = layerRuns(entries, new Set(this.layers.keys()), eyeLayers);
    if (runs.interleaved.length && !this._warnedInterleaved) {
      this._warnedInterleaved = true;
      console.warn(
        `[inline3d/splat] setLayerRig: layer(s) ${runs.interleaved.join(', ')} sit BETWEEN display-rig ` +
          'sublayers; they are drawn before them (with the eye camera). Move them before or after the display layers.',
      );
    }
    this.moved.display = runs.display;
    this.moved.post = runs.post;
    eyeCam.layers = runs.pre;
    if (runs.display.length) {
      this.cams.display ||= this._makeCam('inline3d-eye-display', 1);
      this.cams.display.camera.layers = runs.display;
    }
    if (runs.post.length) {
      this.cams.post ||= this._makeCam('inline3d-eye-post', 2);
      this.cams.post.camera.layers = runs.post;
    }
    if (this.cams.display) this.cams.display.enabled = runs.display.length > 0;
    if (this.cams.post) this.cams.post.enabled = runs.post.length > 0;
    this._key = `${[...this.layers.keys()].join(',')}|${entries.join(',')}|${eyeCam.layers.join(',')}`;
    return runs.display.length > 0;
  }

  /** Every moved layer back on the eye camera, run cameras off (the kill switch / last layer off). */
  restore() {
    const eyeCam = this.viewer.eye?.camera;
    if (eyeCam) {
      const back = [...this.moved.display, ...this.moved.post];
      eyeCam.layers = [...(eyeCam.layers || []), ...back.filter((id) => !(eyeCam.layers || []).includes(id))];
    }
    this.moved = { display: [], post: [] };
    if (this.cams.display) this.cams.display.enabled = false;
    if (this.cams.post) this.cams.post.enabled = false;
    this._key = '';
  }

  /**
   * Per drawn frame, after the eye camera's RenderViews are set. `rig` is the descriptor the
   * runtime located these views with (the viewer snapshots it before the tick can declare anew).
   */
  frame(entries, rect, f, rig) {
    const pc = this.viewer.pc;
    this.last.rounded = false;
    this.last.views = entries.length;
    const frame = cameraRigFrame(rig);
    const k = frame ? layerRigGain(frame, this.opts || {}) : null;
    const round = frame ? roundViews(entries, frame, k, this._round) : null;
    this.last.gain = k;
    for (const run of ['display', 'post']) {
      const cam = this.cams[run];
      if (!cam || !cam.enabled) continue;
      const rvs = this._rvs[run];
      if (rvs.length !== entries.length) {
        rvs.length = 0;
        for (let i = 0; i < entries.length; i++) rvs.push(new pc.RenderView());
        cam.camera.camera.xrViews = rvs.slice();
      }
      const r = run === 'display' ? round : null;
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
      if (run === 'display') {
        // Two camera spaces never share a depth test; in mono (and at gain 1) they are one space.
        cam.camera.clearDepthBuffer = !!r;
        this.last.rounded = !!r;
      }
    }
  }

  destroy() {
    this.restore();
    for (const c of Object.values(this.cams)) c?.destroy?.();
    this.cams = { display: null, post: null };
  }
}

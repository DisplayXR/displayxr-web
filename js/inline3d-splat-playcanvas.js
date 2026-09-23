// inline3d-splat-playcanvas.js — `addSplat(…, { engine: 'playcanvas' })`: the same splat window,
// rendered by the PlayCanvas engine instead of three + Spark.
//
// EXPERIMENTAL. Internal to `./splat`, which imports this module DYNAMICALLY and only when a
// caller asks for `engine: 'playcanvas'` — so a page that never asks never resolves
// `playcanvas`. Not covered by the SDK's 1.x semver promise; see docs/sdk-stability.md and
// docs/playcanvas-adapter.md (what differs from the Spark path, and why).
//
// WHAT IS THE SAME. The handle surface (`ready`, `remove`, `exclude/unexclude`, `setPose`,
// `resetPose`, `setFocus`, `getFocus`, `onFocusChange`, `pick`, `rig`, `camera`, `frame`, `perf`,
// `viewer`, `mesh`), the rig/lens/focus WATERFALL (./inline3d-splat-rig.js, shared verbatim), the
// `.sog` camera block (./inline3d-sog.js), the pose model (yaw/pitch/zoom/depth/focus, eased the
// same way, with the same constants), the auto-fit arithmetic, the mono fallback's cameras, the
// buffer-shape rule (double-width in 3D, 1:1 in mono) and the validate-before-clear +
// last-good-replay rule (web#12). The views still come from the runtime; nothing here builds an
// off-axis projection for the 3D path.
//
// WHAT IS NOT. The subject does not move — the EYES do. SceneViewer rotates and scales the
// content under a fixed camera; here the splat entity never moves and the camera's parent carries
// the INVERSE of that same pivot transform. `RenderView.updateTransforms` multiplies the camera's
// parent world transform into every view, so the runtime's display-space eye poses are
// re-expressed in content space for free, and the engine never re-bakes its work buffer for a
// moving placement. The picture is identical: view × model is the same product either way.
//
// ENGINE SHAPE (one set per tile, same as one WebGLRenderer per tile on the Spark path):
//   AppBase (no XrManager, no mouse/keyboard/touch) on our own WebGL2 device
//   └── root
//       ├── splat   gsplat component, 180° about X (the OpenCV → GL flip)
//       └── rig     ← inverse(pivot), written by THIS module's tick and nothing else
//           └── eye camera, ONE CameraComponent with N `RenderView`s (the engine's own WebXR
//               stereo path, driven without WebXR) — one gsplat manager, one sort, one work
//               buffer for all views.

import {
  resolveRig,
  planeDistance,
  sampleCloudRestSpace,
  sampleCloudCentres,
  centresVisitor,
  RIG_SAMPLE_CAP,
  FRAME_SAMPLE_CAP,
} from './inline3d-splat-rig.js';
import { readSogMeta, sogCameraFromMeta } from './inline3d-sog.js';
import { playcanvasPerfSettings, patchPlayCanvasQuadExtent } from './inline3d-splat-perf.js';
import { boundsFromPositions } from './inline3d-viewer.js';
import { cameraRigFromPose } from './inline3d-three.js';
import { clamp, finite, now, toArray3, canvasNdc, bindFocusGestures } from './inline3d-splat-shared.js';

/** The engine release this adapter was built and measured against (npm peer floor). */
export const PLAYCANVAS_TESTED = '2.22.3';

// ── constants shared with SceneViewer (inline3d-viewer.js). Same values, on purpose: the two
// backends must feel identical under the hand. Copied rather than imported because SceneViewer
// keeps them module-private, and P1 deliberately does not refactor it (docs/playcanvas-adapter.md).
const IDLE_DELAY_MS = 2500;
const FOCUS_EASE = 0.18;
const DEFAULT_DEPTH_LIMIT = 4.0;
const WHEEL_LINE_PX = 33;
const WHEEL_PAGE_PX = 400;
const WHEEL_MAX_PX = 120;
const ZOOM_PER_PX = 0.001;
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 6;
/** SceneViewer's mono camera: `new PerspectiveCamera(35, aspect, 0.001, 1000)`. */
const MONO_FOV = 35;
const MONO_NEAR = 0.001;
const MONO_FAR = 1000;
/** applyCaptureCamera's far: a lifted sky can sit past 239 m and must not clip. */
const CAPTURE_FAR = 5000;
const PICK_CONE_RAD = 0.02;

const DEG = Math.PI / 180;

// ── pure matrix arithmetic (column-major, the layout XRView, three and the engine all use) ──

/** three's `Matrix4.makePerspective(left, right, top, bottom, near, far)`, element for element. */
export function perspectiveOffAxis(left, right, top, bottom, near, far, out = new Float64Array(16)) {
  const x = (2 * near) / (right - left);
  const y = (2 * near) / (top - bottom);
  const a = (right + left) / (right - left);
  const b = (top + bottom) / (top - bottom);
  const c = -(far + near) / (far - near);
  const d = (-2 * far * near) / (far - near);
  out.fill(0);
  out[0] = x;
  out[5] = y;
  out[8] = a;
  out[9] = b;
  out[10] = c;
  out[11] = -1;
  out[14] = d;
  return out;
}

/** three's `PerspectiveCamera.updateProjectionMatrix()` (zoom 1, no film offset, no view). */
export function perspectiveFov(fovDeg, aspect, near, far, out) {
  const top = near * Math.tan(DEG * 0.5 * fovDeg);
  const height = 2 * top;
  const width = aspect * height;
  const left = -0.5 * width;
  return perspectiveOffAxis(left, left + width, top, top - height, near, far, out);
}

/**
 * What a projection matrix says about itself — vertical FOV, aspect, near and far — the same
 * extraction the engine's XrManager does for a headset's views, so LOD and culling see the
 * frustum the views actually have (the engine reads `camera.fov`, not the matrix).
 */
export function frustumFromProjection(P) {
  return {
    fov: (2 * Math.atan(1 / P[5])) / DEG,
    aspectRatio: P[5] / P[0],
    nearClip: P[14] / (P[10] - 1),
    // An infinite-far projection has P[10] = -1 exactly (three's and WebXR's reversed/infinite
    // forms both land here), which would put -Infinity/NaN into setXrProperties. Clamp to the
    // same large finite far the capture camera uses.
    farClip: Math.abs(P[10] + 1) < 1e-9 ? CAPTURE_FAR : P[14] / (P[10] + 1),
  };
}

/** Rigid pose (position + unit quaternion xyzw) as a column-major 4×4. */
export function poseMatrix(p, q, out = new Float64Array(16)) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  out[0] = 1 - (yy + zz); out[1] = xy + wz; out[2] = xz - wy; out[3] = 0;
  out[4] = xy - wz; out[5] = 1 - (xx + zz); out[6] = yz + wx; out[7] = 0;
  out[8] = xz + wy; out[9] = yz - wx; out[10] = 1 - (xx + yy); out[11] = 0;
  out[12] = p[0]; out[13] = p[1]; out[14] = p[2]; out[15] = 1;
  return out;
}

/** Unit quaternion (xyzw) of the rotation part of a rigid column-major 4×4. */
export function quatFromMatrix(m) {
  const m11 = m[0], m12 = m[4], m13 = m[8];
  const m21 = m[1], m22 = m[5], m23 = m[9];
  const m31 = m[2], m32 = m[6], m33 = m[10];
  const tr = m11 + m22 + m33;
  let x, y, z, w;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    w = 0.25 / s; x = (m32 - m23) * s; y = (m13 - m31) * s; z = (m21 - m12) * s;
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    w = (m32 - m23) / s; x = 0.25 * s; y = (m12 + m21) / s; z = (m13 + m31) / s;
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    w = (m13 - m31) / s; x = (m12 + m21) / s; y = 0.25 * s; z = (m23 + m32) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    w = (m21 - m12) / s; x = (m13 + m31) / s; y = (m23 + m32) / s; z = 0.25 * s;
  }
  return [x, y, z, w];
}

/** a × b, column-major. */
export function mat4Mul(a, b, out = new Float64Array(16)) {
  const r = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let row = 0; row < 4; row++) {
      r[c * 4 + row] =
        a[row] * b[c * 4] + a[4 + row] * b[c * 4 + 1] + a[8 + row] * b[c * 4 + 2] + a[12 + row] * b[c * 4 + 3];
    }
  }
  out.set(r);
  return out;
}

/** General 4×4 inverse (column-major); null when singular. */
export function mat4Invert(m, out = new Float64Array(16)) {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  const id = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * id;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * id;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * id;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * id;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * id;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * id;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * id;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * id;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * id;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * id;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * id;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * id;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * id;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * id;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * id;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * id;
  return out;
}

/** m · (x, y, z, 1), perspective-divided. */
export function transformPoint(m, x, y, z) {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
  ];
}

/** Hamilton product a ⊗ b, xyzw. */
function qmul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** Rotate v by unit quaternion q (xyzw). */
function qrot(q, v) {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/** The half turn about X that takes an OpenCV-frame splat (+y down, +z forward) into GL axes. */
const FLIP_Q = [1, 0, 0, 0];

/**
 * SceneViewer's pivot as ONE matrix: content space → display space.
 *
 *   M = T(orbitCentre + (0,0,depthOffset)) · Rx(pitch) · Ry(yaw) · S(fit × zoom) · T(−focus)
 *
 * which is exactly the product of its `_pivot` (position, 'XYZ' rotation, scale) and
 * `_centering` (−focus) groups. Kept as a pure function so a test can hold the two together.
 */
export function pivotMatrix({ yaw = 0, pitch = 0, scale = 1, focus = [0, 0, 0], orbitCentre = [0, 0, 0], depthOffset = 0 }) {
  const q = pivotQuat(yaw, pitch);
  const R = poseMatrix([0, 0, 0], q);
  const out = new Float64Array(16);
  // columns of R·S
  for (let i = 0; i < 12; i++) out[i] = (i % 4 === 3 ? 0 : R[i] * scale);
  const t = [orbitCentre[0], orbitCentre[1], orbitCentre[2] + depthOffset];
  const rf = qrot(q, focus);
  out[12] = t[0] - scale * rf[0];
  out[13] = t[1] - scale * rf[1];
  out[14] = t[2] - scale * rf[2];
  out[15] = 1;
  return out;
}

/** R = Rx(pitch)·Ry(yaw) — three's Euler order 'XYZ' — as a quaternion. */
function pivotQuat(yawDeg, pitchDeg) {
  const a = (pitchDeg * DEG) / 2;
  const b = (yawDeg * DEG) / 2;
  return qmul([Math.sin(a), 0, 0, Math.cos(a)], [0, Math.sin(b), 0, Math.cos(b)]);
}

/**
 * The INVERSE pivot, as the TRS the engine's rig node takes. M⁻¹ = T(f)·S(1/s)·Rᵀ·T(−t), and a
 * uniform scale commutes with a rotation, so it is position f − Rᵀt/s, rotation Rᵀ, scale 1/s.
 */
export function pivotInverseTRS({ yaw = 0, pitch = 0, scale = 1, focus = [0, 0, 0], orbitCentre = [0, 0, 0], depthOffset = 0 }) {
  const q = pivotQuat(yaw, pitch);
  const qi = [-q[0], -q[1], -q[2], q[3]];
  const t = [orbitCentre[0], orbitCentre[1], orbitCentre[2] + depthOffset];
  const rt = qrot(qi, t);
  const inv = 1 / scale;
  return {
    position: [focus[0] - rt[0] * inv, focus[1] - rt[1] * inv, focus[2] - rt[2] * inv],
    rotation: qi,
    scale: inv,
  };
}

/**
 * SceneViewer.fitTo's scale, as a function. Same arithmetic, same order, same clamps — see the
 * reasoning there (swept width, 'height' guard, depth backstop).
 */
export function fitScale({ extent, fit = 'contain', margin = 0.8, vH = 0.24, aspect = 1, fitSweep = true, depthLimit = DEFAULT_DEPTH_LIMIT }) {
  if (fit === 'none') return 1;
  const vW = vH * aspect;
  const ex = Math.max(extent[0], 1e-6);
  const ey = Math.max(extent[1], 1e-6);
  const ez = Math.max(extent[2], 1e-6);
  const horiz = fitSweep ? Math.hypot(ex, ez) : ex;
  let s;
  if (fit === 'cover') s = Math.max((margin * vH) / ey, (margin * vW) / horiz);
  else if (fit === 'contain') s = Math.min((margin * vH) / ey, (margin * vW) / horiz);
  else {
    s = (margin * vH) / ey;
    if (horiz * s > vW) s = vW / horiz;
  }
  const sz = (depthLimit * vH) / ez;
  if (sz < s) s = sz;
  return s;
}

/**
 * The capture camera's mono projection — applyCaptureCamera's off-axis window, principal point
 * honoured, vertical kept and horizontal fitted to the canvas aspect.
 */
export function captureProjection(intrinsics, aspect, near = MONO_NEAR, far = CAPTURE_FAR, out) {
  const { fx, fy, cx, cy, width, height } = intrinsics;
  const top = (near * cy) / fy;
  const bottom = -(near * (height - cy)) / fy;
  const a = aspect > 0 ? aspect : width / height;
  const mid = (near * (width / 2 - cx)) / fx;
  const half = ((top - bottom) * a) / 2;
  return perspectiveOffAxis(mid - half, mid + half, top, bottom, near, far, out);
}

/**
 * The capture camera's POSE in content space — applyCaptureCamera's two half-turns: the OpenCV →
 * GL camera convention on the right always, the content flip on the left under `flipY`.
 */
export function capturePose(rest, flipY) {
  let p = rest.position.slice(0, 3);
  let q = rest.rotation.slice(0, 4);
  if (flipY) {
    p = qrot(FLIP_Q, p);
    q = qmul(FLIP_Q, q);
  }
  q = qmul(q, FLIP_Q);
  return { position: p, rotation: q, matrix: poseMatrix(p, q) };
}

/**
 * The shader override for the engine's non-square-pixel footprint bug.
 *
 * `gsplatCornerVS` derives ONE focal length from the viewport WIDTH and uses it for both axes of
 * the projection Jacobian, which is only right when pixels are square. A side-by-side eye is
 * half-width over a full-height frustum, so every splat was drawn at half its true height:
 * visible vertical stipple, MAE 11.5 against a square-pixel reference in the P0 spike, 1.7 with
 * this. On square pixels (the mono view) it changes nothing (MAE 2.5e-6). Upstream fix pending
 * (epic #36, P4d); until then the anchors are regexes (the npm build re-indents chunks with
 * tabs) and a miss warns once and renders unpatched rather than failing.
 *
 * @returns {{src:string, ok:boolean}}
 */
export function patchGsplatFootprint(src) {
  if (typeof src !== 'string') return { src, ok: false };
  if (src.includes('dxrFocalY')) return { src, ok: true };
  const r1 = /vec2\s+J2\s*=\s*-J1\s*\/\s*vp\.z\s*\*\s*vp\.xy\s*;/;
  const r2 = /0\.0\s*,\s*J1\s*,\s*J2\.y\s*,/;
  if (!r1.test(src) || !r2.test(src)) return { src, ok: false };
  return {
    src: src
      .replace(
        r1,
        'float J1y = (viewport_size.y * matrix_projection[1][1]) / vp.z; /* dxrFocalY */ ' +
          'vec2 J2 = vec2(-J1 / vp.z * vp.x, -J1y / vp.z * vp.y);',
      )
      .replace(r2, '0.0, J1y, J2.y,'),
    ok: true,
  };
}

let warnedFootprint = false;
let warnedQuadExtent = false;
let warnedFeather = false;

/**
 * Which way the engine gets N views into one canvas. `renderview` — one camera, N `RenderView`s
 * — is the design; `cameras` — N cameras with `rect` + `calculateProjection`, all public API,
 * bit-identical in the P0 spike at N× the gsplat memory — is the fallback for an engine build
 * that lacks the XR view plumbing.
 */
export function pickViewPath(pc, forced) {
  if (forced === 'cameras' || forced === 'renderview') return forced;
  const ok = typeof pc?.RenderView === 'function' && !!pc?.Camera?.prototype && 'xrViews' in pc.Camera.prototype;
  return ok ? 'renderview' : 'cameras';
}

/**
 * Which engine loader a source needs. The engine picks its parser from the URL's extension; a
 * byte source gets a synthetic name so it does too.
 *
 * @returns {{ext:'sog'|'ply'|'json', streamed:boolean}|null} null = not something the engine reads.
 */
export function engineFormatFor(src, bytes, fileName) {
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

function pathOf(u) {
  return typeof u === 'string' ? u.split(/[?#]/)[0] : '';
}
function extOf(u) {
  const m = /\.([a-z0-9]+)$/i.exec(pathOf(u));
  return m ? m[1].toLowerCase() : '';
}

/**
 * The pick fallback on flat arrays: the gaussian whose CENTRE is nearest the ray — by angle,
 * then nearest along the ray inside a small cone. Same rule as the Spark path's
 * nearestGaussianToRay, on content-space centres.
 *
 * @param {Float32Array} xyz  content-space centres (already through the flip).
 * @returns {number[]|null} a content-space point.
 */
export function nearestCentreToRay(xyz, origin, dir, coneRad = PICK_CONE_RAD) {
  const n = Math.floor(xyz.length / 3);
  let bestInCone = null;
  let bestInConeT = Infinity;
  let bestAngle = Infinity;
  let bestAny = null;
  for (let i = 0; i < n; i++) {
    const rx = xyz[i * 3] - origin[0];
    const ry = xyz[i * 3 + 1] - origin[1];
    const rz = xyz[i * 3 + 2] - origin[2];
    const t = rx * dir[0] + ry * dir[1] + rz * dir[2];
    if (!(t > 0)) continue;
    const perp = Math.sqrt(Math.max(0, rx * rx + ry * ry + rz * rz - t * t));
    const angle = perp / t;
    if (angle <= coneRad) {
      if (t < bestInConeT) {
        bestInConeT = t;
        bestInCone = [xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]];
      }
    } else if (!bestInCone && angle < bestAngle) {
      bestAngle = angle;
      bestAny = [xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]];
    }
  }
  return bestInCone || bestAny;
}

// ── the viewer: pose state + frame loop + the engine ────────────────────────────────────────

/**
 * The PlayCanvas counterpart of SceneViewer, as far as ./splat uses it: the same pose model and
 * public methods, with the engine behind them instead of three. Not a SceneViewer subclass and
 * not field-compatible with one (docs/playcanvas-adapter.md §Divergences).
 */
export class PlayCanvasSplatViewer {
  constructor(canvas, opts = {}) {
    const {
      virtualDisplayHeight = 0.24,
      fit = 'contain',
      margin = 0.8,
      depthLimit = DEFAULT_DEPTH_LIMIT,
      fitSweep = true,
      orbit = true,
      idleSpin = 0,
      renderScale = 1,
      pitchLimit = [-60, 60],
    } = opts;
    this.canvas = canvas;
    this.vH = virtualDisplayHeight;
    this.fit = fit;
    this.margin = margin;
    this.depthLimit = depthLimit;
    this.fitSweep = fitSweep;
    this.renderScale = renderScale;
    this.pitchLimit = pitchLimit;
    this.idleSpin = idleSpin;
    this.flipY = opts.flipY !== false;

    this._fitScale = 1;
    this._zoom = 1;
    this._targetZoom = 1;
    this._depthOffset = 0;
    this._subjectHalf = [0, 0, 0];
    this._yaw = 0;
    this._pitch = 0;
    this._targetYaw = 0;
    this._targetPitch = 0;
    this._focus = { x: 0, y: 0, z: 0 };
    this._targetFocus = { x: 0, y: 0, z: 0 };
    this._orbitCentre = { x: 0, y: 0, z: 0 };
    this._focusRecentres = true;
    this._focusSettled = true;
    this.onFocusChange = null;
    this.onTick = null;
    this._lastInput = now();
    this._lastTick = 0;
    this._monoRaf = 0;
    this._mode = '3d';
    this._disposed = false;
    this._resizePending = false;
    this._lastGood = null;
    this._vps = [];
    this._reduceMotion =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

    // The mono camera, as numbers. `pose` is display space (the viewer's world), `proj` is
    // recomputed on resize; `capture` swaps in the camera rig's off-axis window.
    this.mono = {
      fov: MONO_FOV,
      near: MONO_NEAR,
      far: MONO_FAR,
      pose: poseMatrix([0, 0, 1], [0, 0, 0, 1]),
      proj: new Float64Array(16),
      capture: null, // intrinsics when on a camera rig
    };
    this._placeMonoForFit();

    // Engine objects — null until attachEngine().
    this.pc = null;
    this.app = null;
    this.eye = null; // camera entity
    this.rigNode = null;
    this.splat = null; // splat entity
    this._views = []; // RenderViews (renderview path) or camera entities (cameras path)
    this._viewPath = null;
    this._frustumKey = '';

    this._onResize = () => this._scheduleResize();
    this._ro = typeof ResizeObserver === 'function' ? new ResizeObserver(this._onResize) : null;
    if (this._ro) this._ro.observe(canvas);
    else if (typeof addEventListener === 'function') addEventListener('resize', this._onResize);

    if (orbit) this._bindOrbit();
    this._resize();

    this.onFrame = this.onFrame.bind(this);
    this.onLayerLost = this.onLayerLost.bind(this);
  }

  // ── public surface (the SceneViewer methods ./splat and pages use) ──

  get is3D() {
    return this._mode === '3d';
  }

  get depthOffset() {
    return this._depthOffset;
  }

  set depthOffset(m) {
    this._depthOffset = finite(m, this._depthOffset);
    this._applyTransform();
  }

  fitTo(center, extent) {
    const c = Array.isArray(center) ? center : [center.x, center.y, center.z];
    const e = Array.isArray(extent) ? extent : [extent.x, extent.y, extent.z];
    this.setFocus(c, { snap: true });
    this._subjectHalf = [Math.abs(e[0]) / 2, Math.abs(e[1]) / 2, Math.abs(e[2]) / 2];
    const box = this.canvas.getBoundingClientRect();
    this._fitScale = fitScale({
      extent: e,
      fit: this.fit,
      margin: this.margin,
      vH: this.vH,
      aspect: box.height > 0 ? box.width / box.height : 1,
      fitSweep: this.fitSweep,
      depthLimit: this.depthLimit,
    });
    this._applyTransform();
    this._placeMonoForFit();
  }

  setPose({ yaw, pitch, zoom, depthOffset } = {}) {
    if (yaw !== undefined) this._targetYaw = this._yaw = yaw;
    if (pitch !== undefined) {
      this._targetPitch = this._pitch = clamp(pitch, this.pitchLimit[0], this.pitchLimit[1]);
    }
    if (zoom !== undefined) this._targetZoom = this._zoom = clamp(zoom, ZOOM_MIN, ZOOM_MAX);
    if (depthOffset !== undefined) this._depthOffset = finite(depthOffset, this._depthOffset);
    this._applyTransform();
  }

  getPose({ target = false } = {}) {
    return {
      yaw: target ? this._targetYaw : this._yaw,
      pitch: target ? this._targetPitch : this._pitch,
      zoom: target ? this._targetZoom : this._zoom,
      depthOffset: this._depthOffset,
    };
  }

  resetPose() {
    this.setPose({ yaw: 0, pitch: 0, zoom: 1, depthOffset: 0 });
    this._lastInput = now();
  }

  /** SceneViewer.getSubjectBounds, same arithmetic. */
  getSubjectBounds() {
    const s = this._fitScale * this._zoom;
    const [hx, hy, hz] = this._subjectHalf;
    const p = this._pitch * DEG;
    const y = this._yaw * DEG;
    const cp = Math.cos(p), sp = Math.sin(p), cy = Math.cos(y), sy = Math.sin(y);
    const ex = s * (Math.abs(cy) * hx + Math.abs(sy) * hz);
    const ey = s * (Math.abs(sp * sy) * hx + Math.abs(cp) * hy + Math.abs(sp * cy) * hz);
    const ez = s * (Math.abs(cp * sy) * hx + Math.abs(sp) * hy + Math.abs(cp * cy) * hz);
    const cz = this._depthOffset;
    return {
      center: { x: 0, y: 0, z: cz },
      extent: { x: 2 * ex, y: 2 * ey, z: 2 * ez },
      front: cz + ez,
      back: cz - ez,
      scale: s,
    };
  }

  setFocus(point, { snap = false, recentre } = {}) {
    if (recentre !== undefined) this._focusRecentres = !!recentre;
    const p = point == null ? [0, 0, 0] : Array.isArray(point) ? point : [point.x, point.y, point.z];
    this._targetFocus = { x: finite(p[0], 0), y: finite(p[1], 0), z: finite(p[2], 0) };
    this._focusSettled = false;
    if (snap) {
      this._focus = { ...this._targetFocus };
      this._focusSettled = true;
      this._applyFocus();
      this._applyTransform();
      this.onFocusChange?.(this._focus);
    }
    return this;
  }

  getFocus({ target = false } = {}) {
    const v = target ? this._targetFocus : this._focus;
    return { x: v.x, y: v.y, z: v.z };
  }

  /** Pose + lens the mono camera as the recording camera (applyCaptureCamera's counterpart). */
  useCaptureCamera(rig) {
    const pose = capturePose(rig.rest, this.flipY);
    this.mono.pose = pose.matrix;
    this.mono.capture = rig.intrinsics;
    this.mono.fov = (2 * Math.atan(rig.intrinsics.height / (2 * rig.intrinsics.fy))) / DEG;
    this.mono.far = Math.max(this.mono.far, CAPTURE_FAR);
    this._updateMonoProjection();
  }

  onLayerLost() {
    if (this._disposed) return;
    this.startMono();
  }

  /** wall.addScene's frame callback. Validate BEFORE drawing; replay the last good frame else. */
  onFrame(views, layer) {
    if (this._disposed) return;
    if (this._mode !== '3d') this.stopMono();
    this._tick();
    if (!views || views.length < 2) {
      this._replayLastGood();
      return;
    }
    const vps = this._vps;
    vps.length = 0;
    for (const view of views) {
      const vp = layer && typeof layer.getViewport === 'function' ? layer.getViewport(view) : null;
      if (!vp || !(vp.width > 0) || !(vp.height > 0)) {
        this._replayLastGood();
        return;
      }
      vps.push(vp);
    }
    this._cacheGood(views, vps);
    this._drawEntries(this._lastGood.entries, this._lastGood);
  }

  startMono() {
    if (this._monoRaf || this._disposed) return;
    this._mode = 'mono';
    this._resize();
    const loop = () => {
      if (this._disposed) return;
      this._monoRaf = requestAnimationFrame(loop);
      this._tick();
      this._drawMono();
    };
    this._monoRaf = requestAnimationFrame(loop);
  }

  stopMono() {
    if (this._monoRaf) cancelAnimationFrame(this._monoRaf);
    this._monoRaf = 0;
    this._mode = '3d';
    this._resize();
  }

  dispose() {
    this._disposed = true;
    this._resizePending = false;
    this._lastGood = null;
    if (this._monoRaf) cancelAnimationFrame(this._monoRaf);
    this._monoRaf = 0;
    if (this._ro) this._ro.disconnect();
    else if (typeof removeEventListener === 'function') removeEventListener('resize', this._onResize);
    this._unbindOrbit();
    try {
      this.app?.destroy();
    } catch (err) {
      console.warn('[inline3d/splat] PlayCanvas app.destroy() threw', err);
    }
    this.app = null;
  }

  // ── engine ──

  /**
   * Build the engine on this canvas. Async only because `createGraphicsDevice` is.
   *
   * @param {object} pc  the `playcanvas` module namespace.
   * @param {object} o
   * @param {boolean} [o.preserveDrawingBuffer=false]  the knob for the weave's zero-copy read
   *        race on large canvases (browser-pvt#24); off by default, like three's path.
   * @param {object} o.perf  the resolved playcanvasPerfSettings().
   * @param {string} [o.viewPath]  force 'cameras' | 'renderview' (diagnostics).
   */
  async attachEngine(pc, { preserveDrawingBuffer = false, perf, viewPath } = {}) {
    this.pc = pc;
    const device = await pc.createGraphicsDevice(this.canvas, {
      deviceTypes: [pc.DEVICETYPE_WEBGL2],
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      xrCompatible: false,
      preserveDrawingBuffer,
    });
    if (this._disposed) {
      device.destroy?.();
      return null;
    }
    const opts = new pc.AppOptions();
    opts.graphicsDevice = device;
    // No xr (AppBase constructs XrManager only when asked, and XrManager is what probes and
    // can request immersive sessions), no mouse/keyboard/touch: the SDK owns input.
    opts.componentSystems = [pc.CameraComponentSystem, pc.GSplatComponentSystem];
    // TextureHandler: a bundled .sog is a zip of webp planes the loader registers as textures.
    opts.resourceHandlers = [pc.TextureHandler, pc.GSplatHandler];
    const app = new pc.AppBase(this.canvas);
    app.init(opts);
    // The SDK sizes the buffer (double-width in 3D, 1:1 in mono), so the engine must never
    // resize it. RESOLUTION_FIXED is AppBase's DEFAULT, and with it `updateCanvasSize()` is a
    // no-op. Deliberately NOT calling setCanvasResolution/setCanvasFillMode: without explicit
    // sizes both write the canvas (a NaN buffer width → 0, and inline `style.width`), which
    // would break the page's own responsive CSS.
    //
    // INVARIANT: the canvas buffer is written ONLY by this module's _resize (canvas.width/height,
    // already in device pixels). Never route a size through the engine: setCanvasResolution →
    // device.resizeCanvas multiplies by DPR a second time (a 2560×720 SBS buffer would become
    // 5120×1440 on a DPR-2 display while the SDK still believes 2560×720). If a future engine
    // changes the default away from FIXED, say so rather than "fixing" it through the engine.
    if (app.resolutionMode !== pc.RESOLUTION_FIXED) {
      console.warn(
        '[inline3d/splat] engine:playcanvas — AppBase.resolutionMode is not RESOLUTION_FIXED on ' +
          'this engine build; the engine may resize the canvas behind the SDK. Tested: ' +
          PLAYCANVAS_TESTED + '.',
      );
    }
    // The SDK's frame drives the engine: no second rAF. `tick` is the engine's own loop body.
    app.requestAnimationFrame = () => {};
    this.app = app;

    // Footprint fix (§ patchGsplatFootprint) and the perf quad-extent cap, both as chunk
    // overrides. The gsplat chunks are registered by GSplatComponentSystem during init, so
    // after it; before any gsplat material compiles.
    const chunks = pc.ShaderChunks.get(device, pc.SHADERLANGUAGE_GLSL);
    const corner = patchGsplatFootprint(chunks.get('gsplatCornerVS'));
    if (corner.ok) chunks.set('gsplatCornerVS', corner.src);
    else if (!warnedFootprint) {
      warnedFootprint = true;
      console.warn(
        '[inline3d/splat] engine:playcanvas — this engine build does not have the gsplatCornerVS ' +
          'lines the non-square-pixel footprint fix rewrites, so it is SKIPPED: side-by-side ' +
          'splats will draw at half height (vertical stipple). Report the engine version; the ' +
          'anchors are in js/inline3d-splat-playcanvas.js.',
      );
    }
    this.footprintPatched = corner.ok;
    if (perf?.quadExtent) {
      const q = patchPlayCanvasQuadExtent(chunks.get('gsplatCommonVS'), perf.quadExtent);
      if (q.ok) chunks.set('gsplatCommonVS', q.src);
      else if (!warnedQuadExtent) {
        warnedQuadExtent = true;
        console.warn(
          '[inline3d/splat] perf.maxStdDev on engine:playcanvas: the gsplatCommonVS anchor is ' +
            'missing, so the quad extent is left at the engine default (everything else applies).',
        );
      }
    }
    for (const [k, v] of Object.entries(perf?.settings || {})) app.scene.gsplat[k] = v;

    // EVERY Entity gets its app EXPLICITLY. The constructor's default is the engine's global
    // "current app" (`getApplication()`), which is whichever AppBase last init'ed or ticked — so
    // with two tiles on a page, the first tile's splat silently joined the second tile's scene
    // and rendered nowhere (found by running two tiles, not by reading).
    this.rigNode = new pc.Entity('inline3d-rig', app);
    app.root.addChild(this.rigNode);
    this._viewPath = pickViewPath(pc, viewPath);
    if (this._viewPath === 'renderview') {
      this.eye = this._makeCamera('inline3d-eye', null);
    }
    this._applyTransform();
    app.start();
    return app;
  }

  /** A camera entity under the rig node. Tonemapping OFF: splat colours are already display-referred. */
  _makeCamera(name, rect) {
    const pc = this.pc;
    const e = new pc.Entity(name, this.app);
    e.addComponent('camera', {
      clearColor: new pc.Color(0, 0, 0, 0),
      nearClip: MONO_NEAR,
      farClip: MONO_FAR,
      fov: MONO_FOV,
      ...(rect ? { rect } : {}),
    });
    // The engine's default camera tonemap is LINEAR, which routes every splat colour through
    // decodeGamma → toneMap → gammaCorrectOutput. Spark writes the stored colour straight out;
    // NONE is the same thing here (GAMMA_SRGB alone leaves a gamma-space colour untouched).
    e.camera.toneMapping = pc.TONEMAP_NONE;
    this.rigNode.addChild(e);
    return e;
  }

  /** Add the loaded asset as the splat entity. */
  addSplatAsset(asset) {
    const pc = this.pc;
    const e = new pc.Entity('inline3d-splat', this.app);
    e.addComponent('gsplat', { asset });
    if (this.flipY) e.setLocalEulerAngles(180, 0, 0);
    this.app.root.addChild(e);
    this.splat = e;
    return e;
  }

  // ── internals ──

  _placeMonoForFit() {
    // SceneViewer.fitTo: distance to make the frustum exactly vH tall at z = 0, looking down −z.
    if (this.mono.capture) return;
    const d = (0.5 * this.vH) / Math.tan((this.mono.fov * DEG) / 2);
    this.mono.pose = poseMatrix([0, 0, d], [0, 0, 0, 1]);
  }

  _updateMonoProjection() {
    const box = this.canvas.getBoundingClientRect();
    const aspect = box.height > 0 ? box.width / box.height : 1;
    if (this.mono.capture) captureProjection(this.mono.capture, aspect, this.mono.near, this.mono.far, this.mono.proj);
    else perspectiveFov(this.mono.fov, aspect, this.mono.near, this.mono.far, this.mono.proj);
  }

  _drawMono() {
    const c = this.canvas;
    this._monoEntry ||= [{ proj: this.mono.proj, pose: this.mono.pose, x: 0, y: 0, width: 0, height: 0 }];
    const e = this._monoEntry[0];
    e.proj = this.mono.proj;
    e.pose = this.mono.pose;
    e.width = c.width;
    e.height = c.height;
    this._drawEntries(this._monoEntry, null);
  }

  /**
   * Put these views on the canvas: N RenderViews on the one camera (or N cameras), then one
   * engine tick. Every entry is {proj, pose, x, y, width, height} in BUFFER pixels.
   */
  _drawEntries(entries, cache) {
    const app = this.app;
    if (!app || !this.pc) return false;
    const pc = this.pc;
    const el = this.canvas;
    const sx = cache && cache.bufW > 0 && el.width ? el.width / cache.bufW : 1;
    const sy = cache && cache.bufH > 0 && el.height ? el.height / cache.bufH : 1;
    const rect = (e) =>
      sx !== 1 || sy !== 1
        ? [Math.round(e.x * sx), Math.round(e.y * sy), Math.max(1, Math.round(e.width * sx)), Math.max(1, Math.round(e.height * sy))]
        : [e.x, e.y, e.width, e.height];

    if (this._viewPath === 'renderview') {
      const rvs = this._views;
      if (rvs.length !== entries.length) {
        rvs.length = 0;
        for (let i = 0; i < entries.length; i++) rvs.push(new pc.RenderView());
        this.eye.camera.camera.xrViews = rvs.slice();
      }
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        rvs[i].setView(e.proj, e.pose);
        const [x, y, w, h] = rect(e);
        rvs[i].setViewport(x, y, w, h);
      }
      // LOD and FOV-compensation read camera.fov/near/far, which under xrViews come from the
      // XR properties — the frustum the views actually have, as XrManager does it.
      const f = frustumFromProjection(entries[0].proj);
      const key = `${f.fov.toFixed(4)}|${f.aspectRatio.toFixed(4)}|${f.nearClip}|${f.farClip}`;
      if (key !== this._frustumKey) {
        this._frustumKey = key;
        this.eye.camera.camera.setXrProperties({ ...f, horizontalFov: false });
      }
      // The camera NODE drives the sort direction and LOD distance; the views ignore it (they
      // compose the node's PARENT with their own pose). Park it on the first eye.
      placeNode(this.eye, entries[0].pose);
    } else {
      // Fallback: one camera per view, `rect` + `calculateProjection`.
      const cams = this._views;
      while (cams.length < entries.length) {
        const cam = this._makeCamera(`inline3d-eye-${cams.length}`, new pc.Vec4(0, 0, 1, 1));
        cam._dxrProj = new Float64Array(16);
        cam.camera.calculateProjection = (out) => out.set(cam._dxrProj);
        // Every camera clears its OWN rect: the WebGL device keeps SCISSOR_TEST on and scissors
        // to the camera rect, so a clear cannot wipe the neighbouring eye.
        cams.push(cam);
      }
      for (let i = 0; i < cams.length; i++) cams[i].enabled = i < entries.length;
      const W = el.width || 1;
      const H = el.height || 1;
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const cam = cams[i];
        cam._dxrProj.set(e.proj);
        const f = frustumFromProjection(e.proj);
        cam.camera.fov = f.fov;
        cam.camera.nearClip = f.nearClip;
        cam.camera.farClip = f.farClip;
        const [x, y, w, h] = rect(e);
        cam.camera.rect = new pc.Vec4(x / W, y / H, w / W, h / H);
        placeNode(cam, e.pose);
      }
    }
    app.tick(now());
    return true;
  }

  _cacheGood(views, vps) {
    const el = this.canvas;
    let g = this._lastGood;
    if (!g || g.entries.length !== views.length) {
      g = this._lastGood = { entries: [], bufW: 0, bufH: 0 };
      for (let i = 0; i < views.length; i++) {
        g.entries.push({ proj: new Float32Array(16), pose: new Float32Array(16), x: 0, y: 0, width: 0, height: 0 });
      }
    }
    g.bufW = el.width || 0;
    g.bufH = el.height || 0;
    for (let i = 0; i < views.length; i++) {
      const e = g.entries[i];
      const vp = vps[i];
      e.proj.set(views[i].projectionMatrix);
      e.pose.set(views[i].transform.matrix);
      e.x = vp.x;
      e.y = vp.y;
      e.width = vp.width;
      e.height = vp.height;
    }
  }

  _replayLastGood() {
    const g = this._lastGood;
    if (!g || this._disposed) return false;
    return this._drawEntries(g.entries, g);
  }

  _scheduleResize() {
    if (this._disposed || this._resizePending) return;
    this._resizePending = true;
    const run = () => {
      if (!this._resizePending) return;
      this._resizePending = false;
      this._resize();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else run();
  }

  /** SceneViewer._resize: double-width in 3D, 1:1 in mono, non-destructive, repaint after. */
  _resize() {
    if (this._disposed) return;
    const box = this.canvas.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return;
    const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2) * this.renderScale;
    const w = Math.max(1, Math.round(box.width * dpr));
    const h = Math.max(1, Math.round(box.height * dpr));
    const bufW = this._mode === 'mono' ? w : w * 2;
    this._updateMonoProjection();
    const el = this.canvas;
    if (el.width === bufW && el.height === h) return;
    el.width = bufW;
    el.height = h;
    if (this._mode === 'mono') this._drawMono();
    else this._replayLastGood();
  }

  _tick() {
    const t = now();
    const dt = this._lastTick ? Math.min((t - this._lastTick) / 1000, 0.1) : 0;
    this._lastTick = t;
    if (this.idleSpin && !this._reduceMotion && t - this._lastInput > IDLE_DELAY_MS) {
      this._targetYaw += this.idleSpin * dt;
    }
    const k = dt > 0 ? 1 - Math.pow(0.001, dt) : 1;
    this._yaw += (this._targetYaw - this._yaw) * k;
    this._pitch += (this._targetPitch - this._pitch) * k;
    if (Math.abs(this._targetZoom - this._zoom) > 1e-4) {
      this._zoom *= Math.pow(this._targetZoom / this._zoom, k);
    } else {
      this._zoom = this._targetZoom;
    }
    this._easeFocus();
    this._applyTransform();
    this.onTick?.();
  }

  _easeFocus() {
    if (this._focusSettled) return;
    const f = this._focus;
    const t = this._targetFocus;
    const dx = t.x - f.x, dy = t.y - f.y, dz = t.z - f.z;
    if (dx * dx + dy * dy + dz * dz < 1e-10) {
      f.x = t.x; f.y = t.y; f.z = t.z;
      this._focusSettled = true;
    } else {
      f.x += dx * FOCUS_EASE; f.y += dy * FOCUS_EASE; f.z += dz * FOCUS_EASE;
    }
    this._applyFocus();
    this.onFocusChange?.(f);
  }

  _applyFocus() {
    const f = this._focus;
    const c = this._orbitCentre;
    c.x = this._focusRecentres ? 0 : f.x;
    c.y = this._focusRecentres ? 0 : f.y;
    c.z = this._focusRecentres ? 0 : f.z;
  }

  /** The pose state as pivotMatrix()'s arguments. */
  pivotState() {
    const f = this._focus;
    const o = this._orbitCentre;
    return {
      yaw: this._yaw,
      pitch: this._pitch,
      scale: this._fitScale * this._zoom,
      focus: [f.x, f.y, f.z],
      orbitCentre: [o.x, o.y, o.z],
      depthOffset: this._depthOffset,
    };
  }

  /**
   * THE ONLY WRITER of the rig node (the 1.7 ownership rule: the tick owns the pivot). The rig
   * node carries the inverse pivot, so the eyes move and the splat stays put.
   */
  _applyTransform() {
    if (!this.rigNode) return;
    const trs = pivotInverseTRS(this.pivotState());
    this.rigNode.setLocalPosition(trs.position[0], trs.position[1], trs.position[2]);
    this.rigNode.setLocalRotation(trs.rotation[0], trs.rotation[1], trs.rotation[2], trs.rotation[3]);
    this.rigNode.setLocalScale(trs.scale, trs.scale, trs.scale);
  }

  _bindOrbit() {
    const el = this.canvas;
    if (typeof el.addEventListener !== 'function') return;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    this._onDown = (ev) => {
      dragging = true;
      lastX = ev.clientX;
      lastY = ev.clientY;
      this._lastInput = now();
      el.setPointerCapture?.(ev.pointerId);
    };
    this._onMove = (ev) => {
      if (!dragging) return;
      const box = el.getBoundingClientRect();
      this._targetYaw += ((ev.clientX - lastX) / Math.max(box.width, 1)) * 180;
      this._targetPitch = clamp(
        this._targetPitch + ((ev.clientY - lastY) / Math.max(box.height, 1)) * 180,
        this.pitchLimit[0],
        this.pitchLimit[1],
      );
      lastX = ev.clientX;
      lastY = ev.clientY;
      this._lastInput = now();
    };
    this._onUp = (ev) => {
      dragging = false;
      this._lastInput = now();
      el.releasePointerCapture?.(ev.pointerId);
    };
    this._onWheel = (ev) => {
      ev.preventDefault();
      let px = ev.deltaY;
      if (ev.deltaMode === 1) px *= WHEEL_LINE_PX;
      else if (ev.deltaMode === 2) px *= WHEEL_PAGE_PX;
      px = clamp(px, -WHEEL_MAX_PX, WHEEL_MAX_PX);
      this._targetZoom = clamp(this._targetZoom * Math.exp(-px * ZOOM_PER_PX), ZOOM_MIN, ZOOM_MAX);
      this._lastInput = now();
    };
    if (el.style) el.style.touchAction = 'none';
    el.addEventListener('pointerdown', this._onDown);
    el.addEventListener('pointermove', this._onMove);
    el.addEventListener('pointerup', this._onUp);
    el.addEventListener('pointercancel', this._onUp);
    el.addEventListener('wheel', this._onWheel, { passive: false });
  }

  _unbindOrbit() {
    const el = this.canvas;
    if (!this._onDown) return;
    el.removeEventListener('pointerdown', this._onDown);
    el.removeEventListener('pointermove', this._onMove);
    el.removeEventListener('pointerup', this._onUp);
    el.removeEventListener('pointercancel', this._onUp);
    el.removeEventListener('wheel', this._onWheel);
    this._onDown = null;
  }

  /** The camera currently on screen: [proj, pose] of the first eye in 3D, the mono camera else. */
  currentView() {
    if (this._mode === '3d' && this._lastGood) return this._lastGood.entries[0];
    return { proj: this.mono.proj, pose: this.mono.pose };
  }
}

/** Put an engine node at a rigid display-space pose (position + rotation; no scale). */
function placeNode(node, m) {
  node.setLocalPosition(m[12], m[13], m[14]);
  const q = quatFromMatrix(m);
  node.setLocalRotation(q[0], q[1], q[2], q[3]);
}

// ── the cloud, from the engine's own resource ───────────────────────────────────────────────

/**
 * Centres (+ peak opacities where the format has them) from a loaded FLAT gsplat resource, for
 * the rig waterfall, the auto-frame and the pick. Model space — the file's own frame, before the
 * flip — which is what Spark's forEachSplat reports too.
 *
 * STRIDED AT COPY TIME to at most FRAME_SAMPLE_CAP splats, the largest sample any consumer takes
 * (the frame pass; the rig pass and the pick stride further, to RIG_SAMPLE_CAP). A copy, because
 * the engine may hand its own arrays to a sort worker, which detaches them — but only the copy it
 * needs: on the 1.18M-gaussian bench asset that is 196,608 splats × 16 B ≈ 3.1 MB instead of
 * 1,179,648 × 16 B ≈ 18.9 MB, and the caller drops it once `ready` has resolved.
 *
 * Centres come from `resource.centers` (the engine computes them for its own sort). Opacities
 * come from the SOG `sh0` plane — alpha is the sigmoid'd opacity in a v2 SOG — through the
 * engine's texture read (a PBO + fence readback, asynchronous; the full plane is transient), or
 * from a PLY's `opacity` property.
 *
 * @returns {Promise<{xyz:Float32Array, opacity:Float32Array|null, total:number, stride:number,
 *          sourceTotal:number}|null>} `total` is the number of splats IN the sample.
 */
export async function readCloud(resource) {
  if (!resource) return null;
  const centers = resource.centers;
  const data = resource.gsplatData;
  const sourceTotal = data?.numSplats || (centers ? Math.floor(centers.length / 3) : 0);
  if (!centers || !sourceTotal) return null;
  const stride = Math.max(1, Math.ceil(sourceTotal / FRAME_SAMPLE_CAP));
  const total = Math.ceil(sourceTotal / stride);
  const xyz = new Float32Array(total * 3);
  for (let j = 0, i = 0; j < total; j++, i += stride) {
    xyz[j * 3] = centers[i * 3];
    xyz[j * 3 + 1] = centers[i * 3 + 1];
    xyz[j * 3 + 2] = centers[i * 3 + 2];
  }
  let opacity = null;
  try {
    if (data?.isSog && data.sh0?.read) {
      const px = await data.sh0.read(0, 0, data.sh0.width, data.sh0.height, { mipLevel: 0, face: 0, immediate: true });
      if (px && px.length >= sourceTotal * 4) {
        opacity = new Float32Array(total);
        const v2 = data.meta?.version === 2;
        const mn = data.meta?.sh0?.mins?.[3];
        const mx = data.meta?.sh0?.maxs?.[3];
        for (let j = 0, i = 0; j < total; j++, i += stride) {
          const a = px[i * 4 + 3] / 255;
          opacity[j] = v2 || mn === undefined ? a : 1 / (1 + Math.exp(-(mn + (mx - mn) * a)));
        }
      }
    } else if (typeof data?.getProp === 'function') {
      const o = data.getProp('opacity');
      if (o && o.length >= sourceTotal) {
        opacity = new Float32Array(total);
        for (let j = 0, i = 0; j < total; j++, i += stride) opacity[j] = 1 / (1 + Math.exp(-o[i]));
      }
    }
  } catch (err) {
    console.warn('[inline3d/splat] could not read splat opacities — the cloud pass runs unfiltered', err);
    opacity = null;
  }
  return { xyz, opacity, total, stride, sourceTotal };
}

/**
 * What kind of resource the engine handed back, and what can be known about it without a cloud.
 *
 * A Streamed SOG (`lod-meta.json`) loads as a `GSplatOctreeResource`: no `centers`, no
 * `gsplatData`, splats arriving by LOD as the camera asks. Its framing falls back to the octree's
 * root bound (`resource.aabb`, the lod-meta `tree.bound` — the engine nulls `data.tree` after
 * reading it), its camera block to the top level of lod-meta.json, and its count to the octree's
 * finest level (`numSplats`; lod-meta's `count` sums every level). Full streaming behaviour
 * (budget per tile, pick on resident LODs) is P2.
 *
 * @returns {{kind:'flat'|'streamed'|null, numSplats:number, meta:object|null,
 *            bounds:{center:number[],extent:number[]}|null}}  bounds in MODEL space.
 */
export function describeResource(res) {
  if (!res) return { kind: null, numSplats: 0, meta: null, bounds: null };
  if (!res.gsplatData && res.octree !== undefined) {
    const a = res.aabb;
    const bounds =
      a && a.center && a.halfExtents
        ? {
            center: [a.center.x, a.center.y, a.center.z],
            extent: [2 * a.halfExtents.x, 2 * a.halfExtents.y, 2 * a.halfExtents.z],
          }
        : null;
    let n = 0;
    try {
      n = res.numSplats || 0;
    } catch {
      n = 0;
    }
    return { kind: 'streamed', numSplats: n || res.data?.count || 0, meta: res.data || null, bounds };
  }
  return { kind: 'flat', numSplats: res.gsplatData?.numSplats ?? 0, meta: res.gsplatData?.meta || null, bounds: null };
}

let warnedStreamedPick = false;

// ── the handle ──────────────────────────────────────────────────────────────────────────────

/**
 * Fill `out` — the handle ./splat already returned synchronously — with the PlayCanvas
 * implementation, and replay whatever the page called on it while this module was loading.
 *
 * @param {object} out  the handle, holding queueing stubs.
 * @param {Array} pending  [[method, args], …] called on the stubs before this ran.
 * @returns {Promise<object>} resolves to `out` once loaded and framed (or removed). The caller
 *          owns `out.ready`; this never writes it.
 */
export function attachPlayCanvasSplat(out, wall, canvas, src, opts, pending = []) {
  const {
    virtualDisplayHeight = 0.24,
    frame = null,
    flipY = true,
    idleSpin = 8,
    orbit = true,
    fit = 'contain',
    margin = 0.8,
    depthLimit = 4.0,
    fitSweep = true,
    renderScale = 1,
    feather = 0,
    perf,
    rig = 'auto',
    focusInput = true,
    fileName,
    observe,
    preserveDrawingBuffer = false,
  } = opts;

  if (feather > 0 && !warnedFeather) {
    warnedFeather = true;
    console.warn('[inline3d/splat] `feather` is not implemented on engine:playcanvas yet — ignored.');
  }

  const perfResolved = playcanvasPerfSettings(perf);
  const viewer = new PlayCanvasSplatViewer(canvas, {
    virtualDisplayHeight,
    fit,
    margin,
    depthLimit,
    fitSweep,
    orbit,
    idleSpin,
    renderScale,
    flipY,
  });

  let handle = null;
  let unbindFocusInput = null;
  let cloud = null; // { xyz, opacity, total } in model space
  let pickCentres = null; // strided content-space centres for pick
  let resourceKind = null; // 'flat' | 'streamed'
  let streamedBounds = null; // model-space octree root bound, Streamed SOG only
  let removed = false;

  Object.assign(out, {
    engine: 'playcanvas',
    viewer,
    mesh: null,
    frame: null,
    camera: null,
    rig: null,
    perf: perfResolved.applied,
    setPose: (p) => viewer.setPose(p),
    resetPose: () => viewer.resetPose(),
    getFocus: (o) => {
      // In MODEL space, like setFocus takes it.
      const f = viewer.getFocus(o);
      return contentToModel([f.x, f.y, f.z]);
    },
    setFocus(point, o = {}) {
      if (!out.mesh || !out.rig) return out;
      const model = point == null ? out.rig.focusDefault : toArray3(point);
      out.rig.focus = model;
      out.rig.focusSource = point == null ? out.rig.focusDefaultSource : 'set';
      out.rig.convergence = planeDistance(out.rig.rest, model);
      viewer.setFocus(modelToContent(model), o);
      return out;
    },
    pick(clientX, clientY) {
      const p = pickPoint(clientX, clientY);
      return p ? contentToModel(p) : null;
    },
    remove() {
      removed = true;
      cloud = null;
      pickCentres = null;
      unbindFocusInput?.();
      viewer.onFocusChange = null;
      handle?.remove();
      viewer.dispose();
    },
    exclude: (el) => handle?.exclude(el),
    unexclude: (el) => handle?.unexclude(el),
  });
  // `onFocusChange` is a plain data property of the handle, read at CALL time — so a callback
  // assigned before this module loaded (on the stub ./splat returned) is the one that fires.
  if (!('onFocusChange' in out)) out.onFocusChange = null;

  /** Model (the file's own frame) → content (the engine world, after the flip). */
  function modelToContent(m) {
    return flipY ? [m[0], -m[1], -m[2]] : [m[0], m[1], m[2]];
  }
  function contentToModel(c) {
    return flipY ? [c[0], -c[1], -c[2]] : [c[0], c[1], c[2]];
  }

  if (wall && wall.supported) {
    handle = wall.addScene(canvas, viewer.onFrame, {
      virtualDisplayHeight,
      onLayerLost: viewer.onLayerLost,
      ...(observe ? { observe } : {}),
    });
  } else {
    viewer.startMono();
  }

  // Replay what the page did before this module arrived — exclude() above all, which a product
  // page calls on the very next line after addSplat.
  for (const [name, args] of pending) {
    if (name === 'remove') {
      out.remove();
      break;
    }
    out[name]?.(...args);
  }

  // ── focus → view rig ──
  let lastConvergence = Number.NaN;
  function pushViewRig(force) {
    if (!out.rig || out.rig.type !== 'camera') return;
    const pose = viewer.mono.pose;
    const f = viewer.getFocus();
    // three looks down −z; convergence is the focus's distance along that axis (the PLANE).
    const fwd = [-pose[8], -pose[9], -pose[10]];
    const d = (f.x - pose[12]) * fwd[0] + (f.y - pose[13]) * fwd[1] + (f.z - pose[14]) * fwd[2];
    if (!force && Math.abs(d - lastConvergence) < 1e-3) return;
    lastConvergence = d;
    out.rig.convergence = d;
    const q = quatFromMatrix(pose);
    out.viewRig = cameraRigFromPose(
      {
        position: { x: pose[12], y: pose[13], z: pose[14] },
        orientation: { x: q[0], y: q[1], z: q[2], w: q[3] },
        fov: viewer.mono.fov,
      },
      {
        convergence: d > 0 ? d : 0,
        ipdFactor: out.rig.ipdFactor,
        parallaxFactor: out.rig.parallaxFactor,
        out: out.viewRig || {},
      },
    );
    handle?.setViewRig?.(out.viewRig);
  }
  viewer.onFocusChange = (f) => {
    pushViewRig(false);
    const cb = out.onFocusChange;
    if (typeof cb === 'function') cb(contentToModel([f.x, f.y, f.z]));
  };

  // ── pick ──
  function pickPoint(clientX, clientY) {
    if (resourceKind === 'streamed') {
      if (!warnedStreamedPick) {
        warnedStreamedPick = true;
        console.warn('[inline3d/splat] pick is unsupported on a Streamed SOG in this version (engine:playcanvas) — returns null.');
      }
      return null;
    }
    if (!pickCentres || !pickCentres.length) return null;
    const ndc = canvasNdc(canvas, clientX, clientY);
    if (!ndc) return null;
    const nx = ndc.x;
    const ny = ndc.y;
    const v = viewer.currentView();
    const invP = mat4Invert(v.proj);
    if (!invP) return null;
    // Display-space ray, then into content space through the inverse pivot.
    const Minv = mat4Invert(pivotMatrix(viewer.pivotState()));
    const toContent = mat4Mul(Minv, v.pose);
    const a = transformPoint(invP, nx, ny, -1);
    const b = transformPoint(invP, nx, ny, 1);
    const o = transformPoint(toContent, a[0], a[1], a[2]);
    const e = transformPoint(toContent, b[0], b[1], b[2]);
    const d = [e[0] - o[0], e[1] - o[1], e[2] - o[2]];
    const len = Math.hypot(d[0], d[1], d[2]) || 1;
    return nearestCentreToRay(pickCentres, o, [d[0] / len, d[1] / len, d[2] / len]);
  }

  function bindFocusInput() {
    if (focusInput === false || unbindFocusInput) return;
    unbindFocusInput = bindFocusGestures(canvas, {
      onDoubleClick: (e) => {
        const p = pickPoint(e.clientX, e.clientY);
        if (!p) return false;
        out.rig.focus = contentToModel(p);
        out.rig.focusSource = 'picked';
        out.rig.convergence = planeDistance(out.rig.rest, out.rig.focus);
        viewer.setFocus(p);
        return true;
      },
      onReset: () => out.setFocus(null),
    });
  }

  // ── load ──
  const loaded = (async () => {
    const pc = opts.playcanvas || (await import('playcanvas'));
    if (removed) return null;
    const app = await viewer.attachEngine(pc, {
      preserveDrawingBuffer,
      perf: perfResolved,
      viewPath: opts.playcanvasViewPath,
    });
    if (!app || removed) return null;

    let bytes = null;
    if (typeof src !== 'string') {
      const buf = src instanceof Blob ? await src.arrayBuffer() : src;
      bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    }
    const fmt = engineFormatFor(src, bytes, fileName);
    if (!fmt) {
      throw new Error(
        "[inline3d/splat] engine:'playcanvas' reads .sog, .ply and a Streamed-SOG lod-meta.json; " +
          'this source is none of those. Use the default engine (Spark) for .spz/.splat/.ksplat.',
      );
    }
    // The camera block off the SAME bytes, before the engine takes them (as the Spark path).
    if (bytes && rig !== 'display') out.camera = sogCameraFromMeta(await readSogMeta(bytes));

    const url = bytes ? `inline3d-bytes-${++byteSeq}.${fmt.ext}` : src;
    const file = bytes
      ? { url, filename: url, contents: new Response(bytes) }
      : { url, filename: pathOf(src).split('/').pop() || url };
    const asset = new pc.Asset(url, 'gsplat', file);
    app.assets.add(asset);
    await new Promise((resolve, reject) => {
      asset.ready(resolve);
      asset.once('error', (err) => reject(err instanceof Error ? err : new Error(String(err))));
      app.assets.load(asset);
    });
    if (removed) return null;
    const res = asset.resource;
    // A URL `.sog` carries its meta in the resource (the engine keeps unknown keys); a Streamed
    // SOG carries it at the top level of lod-meta.json. Both validated by the same reader.
    const desc = describeResource(res);
    resourceKind = desc.kind;
    streamedBounds = desc.bounds;
    if (!bytes && rig !== 'display') out.camera = sogCameraFromMeta(desc.meta);

    cloud = desc.kind === 'flat' ? await readCloud(res) : null;
    if (removed) return null;
    viewer.addSplatAsset(asset);
    out.mesh = {
      numSplats: desc.numSplats || cloud?.sourceTotal || 0,
      entity: viewer.splat,
      asset,
      resource: res,
    };
    return out.mesh;
  })();

  // The load promise is RETURNED, never written to `out.ready`: ./splat's addSplatDeferred owns
  // that field (one promise, one owner, one warning on failure).
  return loaded.then((mesh) => {
      if (!mesh) return out; // removed while loading
      const walk = cloud ? centresVisitor(cloud.xyz, cloud.opacity, cloud.total) : null;
      const local = walk ? boundsFromPositions(sampleCloudCentres(cloud.total, walk) || []) : null;
      const lift = (b) => ({ center: modelToContent(b.center), extent: b.extent.slice(0, 3) });
      // Streamed SOG: no cloud, so the octree's root bound (raw min/max, not percentile-trimmed).
      const bounds = local ? lift(local) : streamedBounds ? lift(streamedBounds) : frame ? lift(frame) : null;

      const sample =
        out.camera?.intrinsics && out.camera?.focus
          ? null
          : walk
            ? sampleCloudRestSpace(cloud.total, walk, out.camera?.rest)
            : null;
      const box = canvas.getBoundingClientRect();
      const resolved = resolveRig({
        camera: out.camera,
        opts,
        cloud: sample,
        canvasAspect: box.height > 0 ? box.width / box.height : 4 / 3,
      });
      resolved.focusDefault = resolved.focus.slice();
      resolved.focusDefaultSource = resolved.focusSource;
      out.rig = resolved;
      out.frame = bounds;

      // Pick set: the shared walker at RIG_SAMPLE_CAP (the Spark fallback's stride), opacity-
      // filtered, then flipped into content space. The only part of the cloud kept after ready.
      if (walk) {
        const sample = sampleCloudCentres(cloud.total, walk, { cap: RIG_SAMPLE_CAP });
        pickCentres = sample ? sample.slice() : null;
        if (pickCentres && flipY) {
          for (let i = 0; i < pickCentres.length; i += 3) {
            pickCentres[i + 1] = -pickCentres[i + 1];
            pickCentres[i + 2] = -pickCentres[i + 2];
          }
        }
      }
      cloud = null; // everything else in it has been consumed

      if (resolved.type === 'camera') {
        if (!('idleSpin' in opts)) viewer.idleSpin = 0;
        viewer.useCaptureCamera(resolved);
        viewer.setFocus(modelToContent(resolved.focus), { snap: true, recentre: false });
        pushViewRig(true);
      } else {
        if (bounds) viewer.fitTo(bounds.center, bounds.extent);
        else console.warn('[inline3d/splat] no usable bounds — subject is UNFRAMED (model scale)', src);
        if (resolved.focusSource === 'caller' || resolved.focusSource === 'block') {
          viewer.setFocus(modelToContent(resolved.focus), { snap: true, recentre: true });
        }
      }
      bindFocusInput();
      return out;
    });
}

let byteSeq = 0;

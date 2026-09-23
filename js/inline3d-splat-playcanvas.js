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
  rigNeedsCloud,
  sampleCloudCentres,
  centresVisitor,
  RIG_SAMPLE_CAP,
  RIG_MIN_OPACITY,
  FRAME_SAMPLE_CAP,
} from './inline3d-splat-rig.js';
import { readSogMeta, sogCameraFromMeta } from './inline3d-sog.js';
import {
  playcanvasPerfSettings,
  patchPlayCanvasQuadExtent,
  tileSplatBudget,
  budgetPerManager,
} from './inline3d-splat-perf.js';
import { boundsFromPositions } from './inline3d-viewer.js';
import { cameraRigFromPose } from './inline3d-three.js';
import {
  clamp,
  finite,
  now,
  toArray3,
  canvasNdc,
  bindFocusGestures,
  DEFAULT_DEPTH_LIMIT,
  IDLE_DELAY_MS,
  FOCUS_EASE,
  DAMP_BASE,
  MAX_DT_S,
  PITCH_LIMIT,
  ORBIT_MAX_DEG,
  ORBIT_TAU_DRAG_S,
  ORBIT_TAU_REST_S,
  WHEEL_LINE_PX,
  WHEEL_PAGE_PX,
  WHEEL_MAX_PX,
  ZOOM_PER_PX,
  ZOOM_MIN,
  ZOOM_MAX,
  MONO_FOV,
  MONO_NEAR,
  MONO_FAR,
  CAPTURE_FAR,
  captureWindow,
  captureVerticalFovDeg,
  engineFormatFor,
  pathOf,
  streamedBytesError,
} from './inline3d-splat-shared.js';

/**
 * The component systems the tile's `AppBase` registers. Camera + GSplat draw the splat; Render,
 * Light and Anim are what a page needs to put a glTF — skinned and animated included — and its
 * lights under `handle.engine.root` (1.9.1; before that the page had to register them itself).
 * Nothing else from the engine's full `Application` list (physics, UI, audio, particles, scripts
 * and so on are the page's own business if it wants them).
 */
export const PLAYCANVAS_SYSTEMS = Object.freeze([
  'CameraComponentSystem',
  'GSplatComponentSystem',
  'RenderComponentSystem',
  'LightComponentSystem',
  'AnimComponentSystem',
]);

/**
 * The resource handlers the tile's loader registers. Texture + GSplat load a splat (a bundled
 * .sog is a zip of webp planes the loader registers as textures); Container loads a .glb/.gltf.
 * The container's sub-assets (render, material, animation) arrive already loaded, so they need no
 * handler of their own.
 */
export const PLAYCANVAS_HANDLERS = Object.freeze(['TextureHandler', 'GSplatHandler', 'ContainerHandler']);

/**
 * Registering a component system the app already has THROWS in the engine ("already
 * registered"). Pages written before 1.9.1 add Render/Light/Anim themselves, so a second `add` of
 * an id that exists is made a no-op that returns the registered system (the duplicate the page
 * constructed is destroyed, so it leaves no listeners behind).
 */
function guardDuplicateSystems(app) {
  const reg = app.systems;
  if (!reg || typeof reg.add !== 'function' || reg._dxrGuarded) return;
  const add = reg.add.bind(reg);
  reg.add = (system) => {
    const existing = system?.id ? reg[system.id] : null;
    if (existing && existing !== system) {
      try {
        system.destroy?.();
      } catch {
        /* a half-built duplicate: nothing to release */
      }
      return existing;
    }
    return add(system);
  };
  reg._dxrGuarded = true;
}

/** The engine release this adapter was built and measured against (npm peer floor). */
export const PLAYCANVAS_TESTED = '2.22.3';

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

/**
 * Raise a perspective projection's near plane to at least `nearFloor` and lower its far plane to
 * at most `farCap`, IN PLACE, leaving the frustum's shape (fov, skew, principal point) untouched —
 * only the depth mapping (P[10], P[14]) is rewritten. Idempotent. A null bound is left alone.
 */
export function clampProjectionDepth(P, nearFloor, farCap) {
  const f0 = frustumFromProjection(P);
  let n = f0.nearClip;
  let f = f0.farClip;
  if (nearFloor !== null && nearFloor !== undefined && nearFloor > n) n = nearFloor;
  if (farCap !== null && farCap !== undefined && farCap < f) f = farCap;
  if (!(f > n)) f = n * 1.0001 + 1e-6;
  if (n === f0.nearClip && f === f0.farClip) return P;
  P[10] = -(f + n) / (f - n);
  P[14] = (-2 * f * n) / (f - n);
  return P;
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
export function captureProjection(intrinsics, aspect, near = MONO_NEAR, far = CAPTURE_FAR, out, captureFit = 'height') {
  const w = captureWindow(intrinsics, aspect, near, captureFit);
  return perspectiveOffAxis(w.left, w.right, w.top, w.bottom, near, far, out);
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

// Source routing lives in ./inline3d-splat-shared.js (./splat also needs it, synchronously, to
// refuse a format this engine cannot read at call time); re-exported for the tests.
export { engineFormatFor, isStreamedUrl, streamedBytesError } from './inline3d-splat-shared.js';

/**
 * The URL the engine loads for a streamed source: a directory URL gets `lod-meta.json` appended
 * (before any query/hash, which are kept); a `lod-meta.json` URL is returned as is. The engine
 * resolves every chunk relative to this URL's directory, so it must name the file itself.
 */
export function streamedEntryUrl(src) {
  if (typeof src !== 'string') return src;
  const m = /^([^?#]*)(.*)$/.exec(src);
  const path = m[1];
  const tail = m[2];
  return path.endsWith('/') ? `${path}lod-meta.json${tail}` : src;
}

/**
 * The pick fallback on flat arrays: the gaussian whose CENTRE is nearest the ray — by angle,
 * then nearest along the ray inside a small cone. Same rule as the Spark path's
 * nearestGaussianToRay, on content-space centres.
 *
 * @param {Float32Array} xyz  centres, in whatever space `origin`/`dir` are in.
 * @param {Uint8Array} [alpha8]  optional peak opacity per splat, 0–255; below RIG_MIN_OPACITY skipped.
 * @returns {number[]|null} a point in the same space.
 */
export function nearestCentreToRay(xyz, origin, dir, coneRad = PICK_CONE_RAD, alpha8 = null, count = Math.floor(xyz.length / 3)) {
  const n = count;
  let bestInCone = null;
  let bestInConeT = Infinity;
  let bestAngle = Infinity;
  let bestAny = null;
  const minA = Math.ceil(RIG_MIN_OPACITY * 255);
  for (let i = 0; i < n; i++) {
    if (alpha8 && alpha8[i] < minA) continue; // haze is not what was clicked
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
      pitchLimit = PITCH_LIMIT,
      orbitMaxDeg = ORBIT_MAX_DEG,
      orbitEase = {},
      feather = 0,
      captureFit = 'height',
      nearClip,
      farClip,
      sky = false,
    } = opts;
    this.canvas = canvas;
    // The engine draws a sky box whenever the scene has something to draw it from — and
    // `scene.envAtlas` counts: a page that sets one to light its own meshes under
    // handle.engine.root got a grey gradient box behind the splat the instant the splat was
    // hidden (mid-setSource, or a page showing only its meshes). The SDK's contract is a
    // transparent canvas the page shows through, so the sky layer is off unless asked for.
    this.sky = sky === true;
    // Depth range for a MIXED scene (meshes under handle.engine.root depth-test against each
    // other; splats only test against them). The projections' own near/far stay the adapter's —
    // these only raise the near (floor) and lower the far (cap). Unset: untouched.
    this.nearClip = Number.isFinite(nearClip) && nearClip > 0 ? nearClip : null;
    this.farClip = Number.isFinite(farClip) && farClip > 0 ? farClip : null;
    // The tilt-and-relax orbit (./inline3d-splat-shared.js §ORBIT): drag tilts up to ±orbitMaxDeg
    // from where the press started, easing with τ = orbitEase.drag; release relaxes back with
    // τ = orbitEase.rest. `_orbitMode` is 'drag' | 'rest' | null (null = ordinary damping).
    this.orbitMaxDeg = orbitMaxDeg;
    this.orbitEase = { drag: orbitEase.drag ?? ORBIT_TAU_DRAG_S, rest: orbitEase.rest ?? ORBIT_TAU_REST_S };
    this._orbitMode = null;
    this.featherPx = feather > 0 ? feather : 0;
    this.captureFit = captureFit;
    /** Called when the capture camera's vertical FOV changes (captureFit 'cover' on a resize). */
    this.onCaptureFov = null;
    /** Per-frame hooks, `(tMs) => boolean` — return false to be removed. setSource's crossfade. */
    this._hooks = [];
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

    // Per-frame splat accounting (handle.stats()). `resident` is what the engine put in the
    // tile's work buffer on the LAST tick — the budget-enforced, LOD-selected set every view of
    // the tile draws from (before per-view frustum culling). `firstFrameAt` is performance.now()
    // (ms since navigation start) of the first tick that drew a non-empty set.
    this.resident = 0;
    this.peakResident = 0;
    this.firstFrameAt = null;
    this._tileBudget = undefined; // undefined = the engine's own default
    this._budgetViews = 1;

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
    // A snap, as on SceneViewer; it also ends an orbit relax (the page is driving now).
    if (yaw !== undefined || pitch !== undefined) this._orbitMode = null;
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
    // SceneViewer's exact arithmetic (degrees → radians as `(d * Math.PI) / 180`), so the two
    // viewers report bit-identical boxes (pinned by the behavioural-trace test).
    const p = (this._pitch * Math.PI) / 180;
    const y = (this._yaw * Math.PI) / 180;
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
    this.mono.fov = captureVerticalFovDeg(rig.intrinsics, NaN, this.mono.near, 'height');
    this.mono.far = Math.max(this.mono.far, CAPTURE_FAR);
    this._updateMonoProjection();
  }

  /** Forget the auto-fit (scale 1, no subject box) — the camera rig's framing. */
  resetFit() {
    this._fitScale = 1;
    this._subjectHalf = [0, 0, 0];
    this._applyTransform();
  }

  /** Back to the display rig's mono camera (setSource from a photo lift to an object). */
  useDisplayCamera() {
    this.mono.capture = null;
    this.mono.fov = MONO_FOV;
    this.mono.far = MONO_FAR;
    this._placeMonoForFit();
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
    // can request immersive sessions), no mouse/keyboard/touch: the SDK owns input. Beyond the
    // splat itself, exactly what a glTF-with-animation under `handle.engine.root` needs — see
    // PLAYCANVAS_SYSTEMS / PLAYCANVAS_HANDLERS.
    opts.componentSystems = PLAYCANVAS_SYSTEMS.map((n) => pc[n]).filter(Boolean);
    opts.resourceHandlers = PLAYCANVAS_HANDLERS.map((n) => pc[n]).filter(Boolean);
    const app = new pc.AppBase(this.canvas);
    app.init(opts);
    guardDuplicateSystems(app);
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
    for (const [k, v] of Object.entries(perf?.settings || {})) {
      if (k !== 'splatBudget') app.scene.gsplat[k] = v;
    }
    // The budget goes through setTileBudget: it is a PER-TILE contract, and the N-camera
    // fallback has to split it (SPLAT_BUDGET_MODEL).
    this.setTileBudget(perf?.settings?.splatBudget);

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
    if (this.featherPx > 0) this._makeFeather();
    this._applyTransform();
    app.start();
    return app;
  }

  /**
   * `feather`: fade each eye's edges to transparent — EdgeFeather's pass, engine-native.
   *
   * A clip-space quad in the UI layer (drawn after the World layer's splats), rendered by the
   * same camera, so the engine draws it once per view into THAT view's viewport: each eye fades
   * all four of ITS OWN edges, which a CSS mask on the canvas cannot do. Blend ZERO/SRC_ALPHA on
   * colour and alpha multiplies whatever is there by the ramp (dst *= ramp), exactly
   * EdgeFeather's blend; the ramp is the same `smoothstep` in both uv axes, sized in BUFFER px
   * per eye viewport so the fade is px-uniform on screen despite the side-by-side squeeze.
   */
  _makeFeather() {
    const pc = this.pc;
    const device = this.app.graphicsDevice;
    const mesh = new pc.Mesh(device);
    mesh.setPositions(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]));
    mesh.setUvs(0, new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]));
    mesh.setIndices([0, 1, 2, 0, 2, 3]);
    mesh.update();
    const mat = new pc.ShaderMaterial({
      uniqueName: 'inline3dEdgeFeather',
      attributes: { vertex_position: pc.SEMANTIC_POSITION, vertex_texCoord0: pc.SEMANTIC_TEXCOORD0 },
      vertexGLSL: `
        attribute vec3 vertex_position;
        attribute vec2 vertex_texCoord0;
        varying vec2 vUv;
        void main() { vUv = vertex_texCoord0; gl_Position = vec4(vertex_position.xy, 0.0, 1.0); }`,
      fragmentGLSL: `
        varying vec2 vUv;
        uniform float dxrFeatherFx;
        uniform float dxrFeatherFy;
        void main() {
          float ax = smoothstep(0.0, dxrFeatherFx, vUv.x) * smoothstep(0.0, dxrFeatherFx, 1.0 - vUv.x);
          float ay = smoothstep(0.0, dxrFeatherFy, vUv.y) * smoothstep(0.0, dxrFeatherFy, 1.0 - vUv.y);
          gl_FragColor = vec4(1.0, 1.0, 1.0, ax * ay);
        }`,
    });
    mat.blendState = new pc.BlendState(
      true,
      pc.BLENDEQUATION_ADD,
      pc.BLENDMODE_ZERO,
      pc.BLENDMODE_SRC_ALPHA,
      pc.BLENDEQUATION_ADD,
      pc.BLENDMODE_ZERO,
      pc.BLENDMODE_SRC_ALPHA,
    );
    mat.depthTest = false;
    mat.depthWrite = false;
    mat.cull = pc.CULLFACE_NONE;
    mat.setParameter('dxrFeatherFx', 0.1);
    mat.setParameter('dxrFeatherFy', 0.1);
    mat.update();
    const mi = new pc.MeshInstance(mesh, mat, new pc.GraphNode('inline3d-feather'));
    mi.cull = false;
    this.app.scene.layers.getLayerById(pc.LAYERID_UI).addMeshInstances([mi]);
    this._feather = { mat, mi };
  }

  /** Size the feather ramp to this frame's eye viewport (buffer px → uv fraction, per axis). */
  _updateFeather(w, h) {
    if (!this._feather) return;
    // 3D ONLY, as on the Spark path: SceneViewer runs EdgeFeather in onFrame (the woven eyes)
    // and not in its flat mono loop, where a page styles the canvas box itself.
    this._feather.mi.visible = this._mode === '3d';
    this._feather.mat.setParameter('dxrFeatherFx', Math.min(0.5, this.featherPx / Math.max(1, w)));
    this._feather.mat.setParameter('dxrFeatherFy', Math.min(0.5, this.featherPx / Math.max(1, h)));
  }

  /**
   * The tile's splat budget, all views included (SPLAT_BUDGET_MODEL). `undefined` leaves the
   * engine's own default alone. On the RenderView path it is the scene budget as is (one manager
   * for all views); on the N-camera fallback it is split across the N per-camera managers.
   */
  setTileBudget(budget) {
    this._tileBudget = Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : undefined;
    this._applyBudget();
  }

  get tileBudget() {
    if (this._tileBudget !== undefined) return this._tileBudget;
    return this.app ? this.app.scene.gsplat.splatBudget : undefined;
  }

  _applyBudget() {
    if (!this.app || this._tileBudget === undefined) return;
    const per = budgetPerManager(this._tileBudget, this._viewPath, this._budgetViews);
    if (this.app.scene.gsplat.splatBudget !== per) this.app.scene.gsplat.splatBudget = per;
  }

  /** Read back what the tick just did. Cheap: two numbers off the renderer. */
  _afterTick() {
    const n = this.app?.renderer?._gsplatCount ?? 0;
    this.resident = n;
    if (n > this.peakResident) this.peakResident = n;
    if (n > 0 && this.firstFrameAt === null) this.firstFrameAt = now();
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
    // No sky unless the page asked (see the constructor): the image-based lighting a page sets
    // still lights its meshes — only the BACKGROUND the sky layer would draw is dropped.
    if (!this.sky && Array.isArray(e.camera.layers)) {
      e.camera.layers = e.camera.layers.filter((id) => id !== pc.LAYERID_SKYBOX);
    }
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
    this.content.addChild(e);
    this.splat = e;
    return e;
  }

  /**
   * The content root: the entity the splat hangs under, in the splat's CONTENT space (engine
   * world — the flip lives on each splat entity, not here). A page may add its own entities under
   * it through `handle.engine.root`; they are destroyed with the app.
   */
  get content() {
    if (!this._content && this.app) {
      this._content = new this.pc.Entity('inline3d-content', this.app);
      this.app.root.addChild(this._content);
    }
    return this._content;
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
    if (this.mono.capture) {
      captureProjection(this.mono.capture, aspect, this.mono.near, this.mono.far, this.mono.proj, this.captureFit);
      if (this.captureFit !== 'height') {
        const fov = captureVerticalFovDeg(this.mono.capture, aspect, this.mono.near, this.captureFit);
        if (fov !== this.mono.fov) {
          this.mono.fov = fov;
          this.onCaptureFov?.();
        }
      }
    } else perspectiveFov(this.mono.fov, aspect, this.mono.near, this.mono.far, this.mono.proj);
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
    if (this.nearClip !== null || this.farClip !== null) {
      for (const e of entries) clampProjectionDepth(e.proj, this.nearClip, this.farClip);
    }
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
      if (this._budgetViews !== entries.length) {
        // One manager per enabled camera here, each reading the scene budget: split it.
        this._budgetViews = entries.length;
        this._applyBudget();
      }
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
    this._updateFeather(entries[0].width * sx, entries[0].height * sy);
    app.tick(now());
    this._afterTick();
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
    const dt = this._lastTick ? Math.min((t - this._lastTick) / 1000, MAX_DT_S) : 0;
    this._lastTick = t;
    // The idle turntable waits out a drag AND its relax, then the usual idle delay.
    if (this.idleSpin && !this._reduceMotion && !this._orbitMode && t - this._lastInput > IDLE_DELAY_MS) {
      this._targetYaw += this.idleSpin * dt;
    }
    const k = dt > 0 ? 1 - Math.pow(DAMP_BASE, dt) : 1;
    // Orbit easing: k = 1 − exp(−dt/τ), τ per phase; no time elapsed, no motion.
    const tau = this._orbitMode === 'drag' ? this.orbitEase.drag : this._orbitMode === 'rest' ? this.orbitEase.rest : 0;
    const ko = tau > 0 ? (dt > 0 ? 1 - Math.exp(-dt / tau) : 0) : k;
    this._yaw += (this._targetYaw - this._yaw) * ko;
    this._pitch += (this._targetPitch - this._pitch) * ko;
    if (
      this._orbitMode === 'rest' &&
      Math.abs(this._targetYaw - this._yaw) < 0.01 &&
      Math.abs(this._targetPitch - this._pitch) < 0.01
    ) {
      this._orbitMode = null; // at rest: the ordinary damping (and the idle turntable) take over
    }
    if (Math.abs(this._targetZoom - this._zoom) > 1e-4) {
      this._zoom *= Math.pow(this._targetZoom / this._zoom, k);
    } else {
      this._zoom = this._targetZoom;
    }
    this._easeFocus();
    this._applyTransform();
    if (this._hooks.length) {
      // A hook may push another (the crossfade schedules the release): run a snapshot, keep both.
      const run = this._hooks;
      this._hooks = [];
      const keep = run.filter((h) => h(t) !== false);
      this._hooks = keep.concat(this._hooks);
    }
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

  /**
   * The built-in orbit: TILT-AND-RELAX, not SceneViewer's cumulative turntable drag.
   *
   * The drag is a FRACTION of the canvas box (dx = Δx / width, dy = Δy / height, measured from
   * the press), so a tablet thumb-swipe and a mouse agree whatever the tile's pixel size. The
   * target is ABSOLUTE from the press — rest + clamp(dx · 2·max, ±max) — so a half-width swipe
   * reaches the cap (orbitMaxDeg, 15° by default). +dx ⇒ +yaw and +dy ⇒ +pitch, SceneViewer's
   * signs (the near face follows the pointer). Release relaxes back to the rest pose — the pose
   * the press started from, which is yaw = pitch = 0 for a page that never setPose'd — rather
   * than snapping. `pitchLimit` still clamps. `setPose` stays a snap, so page-driven easing works.
   */
  _bindOrbit() {
    const el = this.canvas;
    if (typeof el.addEventListener !== 'function') return;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let restYaw = 0;
    let restPitch = 0;
    this._onDown = (ev) => {
      dragging = true;
      startX = ev.clientX;
      startY = ev.clientY;
      // Rest = where the pose was heading when pressed (an idle turntable's yaw included).
      restYaw = this._orbitMode ? restYaw : this._targetYaw;
      restPitch = this._orbitMode ? restPitch : this._targetPitch;
      this._orbitMode = 'drag';
      this._lastInput = now();
      el.setPointerCapture?.(ev.pointerId);
    };
    this._onMove = (ev) => {
      if (!dragging) return;
      const box = el.getBoundingClientRect();
      const dx = (ev.clientX - startX) / Math.max(box.width, 1);
      const dy = (ev.clientY - startY) / Math.max(box.height, 1);
      const max = this.orbitMaxDeg;
      this._targetYaw = restYaw + clamp(dx * 2 * max, -max, max);
      this._targetPitch = clamp(
        restPitch + clamp(dy * 2 * max, -max, max),
        this.pitchLimit[0],
        this.pitchLimit[1],
      );
      this._lastInput = now();
    };
    this._onUp = (ev) => {
      if (!dragging) return;
      dragging = false;
      this._targetYaw = restYaw;
      this._targetPitch = clamp(restPitch, this.pitchLimit[0], this.pitchLimit[1]);
      this._orbitMode = 'rest';
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
    el.addEventListener('pointerleave', this._onUp);
    el.addEventListener('wheel', this._onWheel, { passive: false });
  }

  _unbindOrbit() {
    const el = this.canvas;
    if (!this._onDown) return;
    el.removeEventListener('pointerdown', this._onDown);
    el.removeEventListener('pointermove', this._onMove);
    el.removeEventListener('pointerup', this._onUp);
    el.removeEventListener('pointercancel', this._onUp);
    el.removeEventListener('pointerleave', this._onUp);
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
/**
 * A `performance.measure` named `inline3d:<name>` from `t0` to now — so a load's stages show up in
 * DevTools' Performance panel and in `performance.getEntriesByType('measure')`. Never throws.
 */
/**
 * Give the main thread back for one turn — input, rAF, the engine's own tick — before the next
 * chunk of cloud work. `scheduler.yield()` where the browser has it (keeps our task's priority),
 * else a macrotask.
 */
function yieldToMain() {
  if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') return scheduler.yield();
  return new Promise((r) => setTimeout(r, 0));
}

function perfSpan(name, t0) {
  try {
    performance.measure?.(`inline3d:${name}`, { start: t0, end: performance.now() });
  } catch {
    /* no User Timing L3 here */
  }
}

export async function readCloud(resource) {
  if (!resource) return null;
  const centers = resource.centers;
  const data = resource.gsplatData;
  const sourceTotal = data?.numSplats || (centers ? Math.floor(centers.length / 3) : 0);
  if (!centers || !sourceTotal) return null;
  const stride = Math.max(1, Math.ceil(sourceTotal / FRAME_SAMPLE_CAP));
  const total = Math.ceil(sourceTotal / stride);
  // Not in the task that delivered the asset: the engine's own end-of-load work (its centre
  // readback unpack) runs there, and stacking ours on it made one long task.
  await yieldToMain();
  let t0 = performance.now();
  const xyz = new Float32Array(total * 3);
  for (let j = 0, i = 0; j < total; j++, i += stride) {
    xyz[j * 3] = centers[i * 3];
    xyz[j * 3 + 1] = centers[i * 3 + 1];
    xyz[j * 3 + 2] = centers[i * 3 + 2];
  }
  perfSpan('readCloud:copy', t0);
  await yieldToMain();
  let opacity = null;
  // Full-resolution peak opacity, ONE BYTE per splat, kept for the exact pick (which walks the
  // engine's own full centre set at pick time): 1.18 MB on the 1.18M bench asset.
  let alpha8 = null;
  try {
    if (data?.isSog && data.sh0?.read) {
      t0 = performance.now();
      const px = await data.sh0.read(0, 0, data.sh0.width, data.sh0.height, { mipLevel: 0, face: 0, immediate: true });
      perfSpan('readCloud:sh0-readback(async)', t0);
      await yieldToMain();
      t0 = performance.now();
      if (px && px.length >= sourceTotal * 4) {
        const v2 = data.meta?.version === 2;
        const mn = data.meta?.sh0?.mins?.[3];
        const mx = data.meta?.sh0?.maxs?.[3];
        const op = (i) => {
          const a = px[i * 4 + 3] / 255;
          return v2 || mn === undefined ? a : 1 / (1 + Math.exp(-(mn + (mx - mn) * a)));
        };
        opacity = new Float32Array(total);
        for (let j = 0, i = 0; j < total; j++, i += stride) opacity[j] = op(i);
        alpha8 = new Uint8Array(sourceTotal);
        if (v2 || mn === undefined) for (let i = 0; i < sourceTotal; i++) alpha8[i] = px[i * 4 + 3];
        else for (let i = 0; i < sourceTotal; i++) alpha8[i] = Math.round(op(i) * 255);
      }
      perfSpan('readCloud:opacity', t0);
    } else if (typeof data?.getProp === 'function') {
      const o = data.getProp('opacity');
      if (o && o.length >= sourceTotal) {
        opacity = new Float32Array(total);
        for (let j = 0, i = 0; j < total; j++, i += stride) opacity[j] = 1 / (1 + Math.exp(-o[i]));
        alpha8 = new Uint8Array(sourceTotal);
        for (let i = 0; i < sourceTotal; i++) alpha8[i] = Math.round(255 / (1 + Math.exp(-o[i])));
      }
    }
  } catch (err) {
    console.warn('[inline3d/splat] could not read splat opacities — the cloud pass runs unfiltered', err);
    opacity = null;
    alpha8 = null;
  }
  return { xyz, opacity, alpha8, total, stride, sourceTotal };
}

/**
 * A point sample standing in for a Streamed SOG's cloud, from its octree alone: every leaf node
 * contributes points in proportion to its finest-level splat count, spread deterministically
 * through its box. That is enough for the SAME percentile framing a flat source gets
 * (boundsFromPositions), which the octree's root bound cannot give — the root is the raw
 * container of every chunk, sky shells and floaters included (a captured castle: 391×821×390 m
 * root against 65×25×76 m measured on the flat file; a museum room: ±240 m around a 2 m statue).
 *
 * Coarse by construction (a node is a box, not its splats), so framing lands within a node size
 * of the flat measurement, not on it. Nothing is downloaded: lod-meta.json already lists every
 * node's box and count.
 *
 * @param {Array<{min:number[], max:number[], count:number}>} nodes
 * @param {number} [cap]  points to emit in total (default 20k).
 * @returns {Float32Array|null} xyz, model space.
 */
export function octreeSample(nodes, cap = 20000) {
  if (!Array.isArray(nodes) || !nodes.length) return null;
  let total = 0;
  for (const n of nodes) total += n.count > 0 ? n.count : 0;
  if (!(total > 0)) return null;
  const pts = [];
  let seed = 0x9e3779b9;
  const rnd = () => {
    // xorshift32: deterministic, so a test (and a reload) frames the same way every time.
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 4294967296;
  };
  let carry = 0;
  for (const n of nodes) {
    if (!(n.count > 0)) continue;
    carry += (n.count / total) * cap;
    const k = Math.floor(carry);
    carry -= k;
    for (let i = 0; i < k; i++) {
      pts.push(
        n.min[0] + (n.max[0] - n.min[0]) * rnd(),
        n.min[1] + (n.max[1] - n.min[1]) * rnd(),
        n.min[2] + (n.max[2] - n.min[2]) * rnd(),
      );
    }
  }
  return pts.length ? Float32Array.from(pts) : null;
}

/** The engine octree's leaf nodes as octreeSample() input. */
function octreeNodes(res) {
  const nodes = res?.octree?.nodes;
  if (!Array.isArray(nodes)) return [];
  const out = [];
  for (const n of nodes) {
    const b = n?.bounds;
    const c = n?.lods?.[0]?.count ?? 0;
    if (!b || !b.center || !b.halfExtents || !(c > 0)) continue;
    out.push({
      min: [b.center.x - b.halfExtents.x, b.center.y - b.halfExtents.y, b.center.z - b.halfExtents.z],
      max: [b.center.x + b.halfExtents.x, b.center.y + b.halfExtents.y, b.center.z + b.halfExtents.z],
      count: c,
    });
  }
  return out;
}

/**
 * What kind of resource the engine handed back, and what can be known about it without a cloud.
 *
 * A Streamed SOG (`lod-meta.json`) loads as a `GSplatOctreeResource`: no `centers`, no
 * `gsplatData`, splats arriving by LOD as the camera asks. Its framing comes from the octree's
 * leaf boxes (octreeSample → the same percentile bounds a flat cloud gets), else from the root
 * bound (`resource.aabb`, the lod-meta `tree.bound` — the engine nulls `data.tree` after
 * reading it); its camera block from the top level of lod-meta.json; its count from the octree's
 * finest level (`numSplats`; lod-meta's `count` sums every level). What is on screen in a given
 * frame is `handle.stats().resident`, capped by the tile budget (SPLAT_BUDGET_MODEL); `pick`
 * searches the chunks currently resident.
 *
 * @returns {{kind:'flat'|'streamed'|null, numSplats:number, meta:object|null,
 *            bounds:{center:number[],extent:number[]}|null, boundsSource?:string,
 *            rootBounds?:object|null}}  bounds in MODEL space.
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
    const sample = octreeSample(octreeNodes(res));
    const sampled = sample ? boundsFromPositions(sample) : null;
    return {
      kind: 'streamed',
      numSplats: n || res.data?.count || 0,
      meta: res.data || null,
      bounds: sampled || bounds,
      boundsSource: sampled ? 'octree-sample' : bounds ? 'octree-root' : null,
      rootBounds: bounds,
    };
  }
  return { kind: 'flat', numSplats: res.gsplatData?.numSplats ?? 0, meta: res.gsplatData?.meta || null, bounds: null };
}

// ── the handle ──────────────────────────────────────────────────────────────────────────────

/**
 * The per-splat crossfade for `setSource`: a work-buffer modifier multiplying each splat's alpha
 * by this ENTITY's `dxrFade` parameter.
 *
 * Per entity, not per material: the engine's unified renderer composites every splat of a tile
 * through ONE material and ONE work buffer, so a material uniform cannot tell the outgoing asset
 * from the incoming one. `setWorkBufferModifier` + `setParameter` is the engine's supported
 * per-component hook for exactly this; during a fade the work buffer is re-rendered each frame
 * (WORKBUFFER_UPDATE_ALWAYS), and the modifier is removed when the fade ends.
 */
const FADE_MODIFIER_GLSL = `
uniform float dxrFade;
void modifySplatCenter(inout vec3 center) {}
void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {}
void modifySplatColor(vec3 center, inout vec4 color) { color.a *= dxrFade; }
`;

/** Set (or clear, with null) the crossfade alpha on one splat entity. */
function setFade(pc, entity, value) {
  const g = entity?.gsplat;
  if (!g) return;
  if (value === null) {
    g._dxrFading = false;
    g.setWorkBufferModifier?.(null);
    g.deleteParameter?.('dxrFade');
    if ('workBufferUpdate' in g) g.workBufferUpdate = pc.WORKBUFFER_UPDATE_ONCE ?? 1;
    return;
  }
  if (!g._dxrFading) {
    g._dxrFading = true;
    g.setWorkBufferModifier?.({ glsl: FADE_MODIFIER_GLSL });
    if ('workBufferUpdate' in g) g.workBufferUpdate = pc.WORKBUFFER_UPDATE_ALWAYS ?? 2;
  }
  g.setParameter?.('dxrFade', value);
}

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
    depthLimit = DEFAULT_DEPTH_LIMIT,
    fitSweep = true,
    renderScale = 1,
    feather = 0,
    perf,
    rig = 'auto',
    captureFit = 'height',
    focusInput = true,
    observe,
    firstWovenHoldMs,
    preserveDrawingBuffer = false,
  } = opts;
  // `sortIntervalMs` is accepted and has no effect here: the engine re-sorts when the camera
  // ROTATES (one directional sort serves every view), not on a timer — docs/playcanvas-adapter.md.

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
    orbitMaxDeg: opts.orbitMaxDeg,
    orbitEase: opts.orbitEase,
    feather,
    captureFit,
    nearClip: opts.nearClip,
    farClip: opts.farClip,
    sky: opts.sky,
  });

  let handle = null;
  let unbindFocusInput = null;
  let removed = false;
  /** The asset on screen: its resource, kind, the pick data it keeps. */
  let current = null; // { asset, entity, res, kind, streamedBounds, alpha8, pickCentres }

  Object.assign(out, {
    backend: 'playcanvas',
    engine: null, // { app, root, camera } once the engine has booted — see below
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
      return pickModel(clientX, clientY);
    },
    setSource,
    remove() {
      removed = true;
      current = null;
      unbindFocusInput?.();
      viewer.onFocusChange = null;
      handle?.remove();
      viewer.dispose(); // app.destroy(): every entity — ours and any a page added — goes with it
    },
    exclude: (el) => handle?.exclude(el),
    unexclude: (el) => handle?.unexclude(el),
    stats: () => splatStats(),
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
      ...(firstWovenHoldMs !== undefined ? { firstWovenHoldMs } : {}),
    });
  } else {
    viewer.startMono();
  }
  // Settle the stub's `firstWoven` (addSplatDeferred) with the core handle's own.
  if (typeof out._resolveFirstWoven === 'function') {
    out._resolveFirstWoven(handle ? handle.firstWoven : Promise.resolve(Object.freeze({ woven: false, confirmed: false, reason: 'unsupported', ms: 0 })));
    delete out._resolveFirstWoven;
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
    // Second argument: which waterfall step the focus came from ('block', 'nearest-clump', …).
    if (typeof cb === 'function') cb(contentToModel([f.x, f.y, f.z]), { focusSource: out.rig?.focusSource ?? null });
  };
  // captureFit 'cover' re-crops on resize, which changes the rig's vertical FOV: re-declare it.
  viewer.onCaptureFov = () => pushViewRig(true);

  // ── stats ──
  function splatStats() {
    const c = current;
    const oct = c?.kind === 'streamed' ? c.res?.octree : null;
    const budget = viewer.tileBudget;
    return {
      kind: c?.kind ?? null,
      resident: viewer.resident,
      peakResident: viewer.peakResident,
      budget: Number.isFinite(budget) ? budget : null,
      numSplats: out.mesh?.numSplats ?? 0,
      views: viewer._lastGood && viewer.is3D ? viewer._lastGood.entries.length : 1,
      lodLevels: oct ? oct.lodLevels : null,
      files: oct ? oct.files.length : null,
      filesLoaded: oct ? oct.fileResources.size : null,
      firstFrameMs: viewer.firstFrameAt,
    };
  }

  // ── pick ──
  /** The ray under a client point, in MODEL space (through the inverse pivot and the flip). */
  function modelRay(clientX, clientY) {
    const ndc = canvasNdc(canvas, clientX, clientY);
    if (!ndc) return null;
    const v = viewer.currentView();
    const invP = mat4Invert(v.proj);
    if (!invP) return null;
    const Minv = mat4Invert(pivotMatrix(viewer.pivotState()));
    const toContent = mat4Mul(Minv, v.pose);
    const a = transformPoint(invP, ndc.x, ndc.y, -1);
    const b = transformPoint(invP, ndc.x, ndc.y, 1);
    const o = contentToModel(transformPoint(toContent, a[0], a[1], a[2]));
    const e = contentToModel(transformPoint(toContent, b[0], b[1], b[2]));
    const d = [e[0] - o[0], e[1] - o[1], e[2] - o[2]];
    const len = Math.hypot(d[0], d[1], d[2]) || 1;
    return { o, d: [d[0] / len, d[1] / len, d[2] / len] };
  }

  /**
   * EXACT nearest-centre pick over the FULL centre set, at pick time: the engine keeps every
   * centre for its own sort (`resource.centers`), and the adapter keeps one opacity byte per
   * splat to skip haze. A Streamed SOG picks over the chunks currently RESIDENT (no opacity
   * filter there yet). Returns a MODEL-space point.
   */
  function pickModel(clientX, clientY) {
    const c = current;
    if (!c) return null;
    const ray = modelRay(clientX, clientY);
    if (!ray) return null;
    if (c.kind === 'streamed') {
      let best = null;
      let bestT = Infinity;
      const res = c.res?.octree?.fileResources;
      if (res && typeof res.values === 'function') {
        for (const chunk of res.values()) {
          const xyz = chunk?.centers;
          if (!xyz || !xyz.length) continue;
          const p = nearestCentreToRay(xyz, ray.o, ray.d);
          if (!p) continue;
          const t = (p[0] - ray.o[0]) * ray.d[0] + (p[1] - ray.o[1]) * ray.d[1] + (p[2] - ray.o[2]) * ray.d[2];
          if (t < bestT) {
            bestT = t;
            best = p;
          }
        }
      }
      return best;
    }
    const full = c.res?.centers;
    if (full && full.length) return nearestCentreToRay(full, ray.o, ray.d, undefined, c.alpha8);
    // The engine released its centres: fall back to the strided set kept at load.
    return c.pickCentres ? nearestCentreToRay(c.pickCentres, ray.o, ray.d) : null;
  }

  function bindFocusInput() {
    if (focusInput === false || unbindFocusInput) return;
    unbindFocusInput = bindFocusGestures(canvas, {
      onDoubleClick: (e) => {
        const m = pickModel(e.clientX, e.clientY);
        if (!m) return false;
        out.rig.focus = m;
        out.rig.focusSource = 'picked';
        out.rig.convergence = planeDistance(out.rig.rest, out.rig.focus);
        viewer.setFocus(modelToContent(m));
        return true;
      },
      onReset: () => out.setFocus(null),
    });
  }

  // ── load ──
  let byteSeqLocal = 0;
  /** Fetch/parse one source into an engine asset, and read what the waterfall needs from it. */
  async function loadOne(pc, app, source) {
    let bytes = null;
    if (typeof source !== 'string') {
      const buf = source instanceof Blob ? await source.arrayBuffer() : source;
      bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    }
    if (bytes) {
      // Also caught synchronously by ./splat for Uint8Array/ArrayBuffer; a Blob, and setSource,
      // only arrive here.
      const streamedErr = streamedBytesError(bytes, opts.fileName);
      if (streamedErr) throw new Error(`[inline3d/splat] ${streamedErr}`);
    }
    const fmt = engineFormatFor(source, bytes, opts.fileName, opts.fileType);
    if (!fmt) {
      throw new Error(
        "[inline3d/splat] engine:'playcanvas' reads .sog, .ply and a Streamed-SOG lod-meta.json; " +
          "this source is none of those. Pass engine:'spark' for .spz/.splat/.ksplat.",
      );
    }
    // The camera block off the SAME bytes, before the engine takes them (as the Spark path).
    let camera = null;
    let t0 = performance.now();
    if (bytes && rig !== 'display') camera = sogCameraFromMeta(await readSogMeta(bytes));
    perfSpan('readSogMeta(async)', t0);

    const url = bytes
      ? `inline3d-bytes-${++byteSeq}-${++byteSeqLocal}.${fmt.ext}`
      : fmt.streamed
        ? streamedEntryUrl(source)
        : source;
    const file = bytes
      ? { url, filename: url, contents: new Response(bytes) }
      : { url, filename: pathOf(url).split('/').pop() || url };
    const asset = new pc.Asset(url, 'gsplat', file);
    app.assets.add(asset);
    t0 = performance.now();
    await new Promise((resolve, reject) => {
      asset.ready(resolve);
      asset.once('error', (err) => reject(err instanceof Error ? err : new Error(String(err))));
      app.assets.load(asset);
    });
    perfSpan('engine-load(async)', t0);
    const res = asset.resource;
    const desc = describeResource(res);
    // A URL `.sog` carries its meta in the resource (the engine keeps unknown keys); a Streamed
    // SOG carries it at the top level of lod-meta.json. Both validated by the same reader.
    if (!bytes && rig !== 'display') camera = sogCameraFromMeta(desc.meta);
    const cloud = desc.kind === 'flat' ? await readCloud(res) : null;
    // The cloud passes, each in its OWN task: framing, the rest-space sample and the pick set
    // were one ~60 ms main-thread block on a 1.18M-gaussian swap — pointer input waited on it.
    // Split with a yield between them (and a linear-time percentile in boundsFromPositions),
    // no single step is a long task any more. Same numbers, same order.
    const pre = { local: null, rest: null, pickCentres: null };
    if (cloud) {
      const walk = centresVisitor(cloud.xyz, cloud.opacity, cloud.total);
      await yieldToMain();
      let t = performance.now();
      pre.local = boundsFromPositions(sampleCloudCentres(cloud.total, walk) || []);
      perfSpan('cloud:bounds', t);
      await yieldToMain();
      t = performance.now();
      if (rigNeedsCloud(camera)) pre.rest = sampleCloudRestSpace(cloud.total, walk, camera?.rest);
      perfSpan('cloud:rest-sample', t);
      await yieldToMain();
      t = performance.now();
      const s = sampleCloudCentres(cloud.total, walk, { cap: RIG_SAMPLE_CAP });
      pre.pickCentres = s ? s.slice() : null;
      perfSpan('cloud:pick-set', t);
      await yieldToMain();
    }
    return { asset, res, desc, camera, cloud, pre };
  }

  /**
   * THE WATERFALL for one loaded asset: bounds, rig, lens, focus — then frame it. Shared by the
   * first load and every setSource, so a swapped-in file is judged exactly like a first one.
   */
  function applyLoaded(loaded) {
    const { cloud, desc } = loaded;
    const tB = performance.now();
    const local = loaded.pre?.local || null;
    const lift = (b) => ({ center: modelToContent(b.center), extent: b.extent.slice(0, 3) });
    // Measured first — the Spark path's order (a supplied frame is only a fallback there too).
    // A Streamed SOG has no cloud: there a caller's `frame` beats the octree-derived bounds
    // (describeResource: a count-weighted sample of the leaf boxes, else the raw root bound),
    // because both are coarser than a real measurement.
    const bounds = local
      ? lift(local)
      : desc.kind === 'streamed' && frame
        ? lift(frame)
        : desc.bounds
          ? lift(desc.bounds)
          : frame
            ? lift(frame)
            : null;

    const sample = loaded.pre?.rest || null;
    const box = canvas.getBoundingClientRect();
    const resolved = resolveRig({
      camera: loaded.camera,
      opts,
      cloud: sample,
      canvasAspect: box.height > 0 ? box.width / box.height : 4 / 3,
    });
    resolved.focusDefault = resolved.focus.slice();
    resolved.focusDefaultSource = resolved.focusSource;
    perfSpan('applyLoaded:rig', tB);
    out.camera = loaded.camera;
    out.rig = resolved;
    out.frame = bounds;
    // The tile budget, now that the kind is known: the caller's, else the streamed default on a
    // Streamed SOG, else the engine's (STREAMED_SPLAT_BUDGET, SPLAT_BUDGET_MODEL).
    const budget = tileSplatBudget(perfResolved, desc.kind);
    viewer.setTileBudget(budget);
    if (perfResolved.applied) {
      out.perf = budget !== undefined ? { ...perfResolved.applied, splatBudget: budget } : perfResolved.applied;
    }

    // The strided pick fallback (used only if the engine releases its full centre set).
    const pickCentres = loaded.pre?.pickCentres || null;

    if (resolved.type === 'camera') {
      if (!('idleSpin' in opts)) viewer.idleSpin = 0;
      // The camera rig never auto-fits (the capture IS the framing): a scale left by a previous
      // display-rig asset (setSource) must not shrink this one.
      viewer.resetFit();
      viewer.useCaptureCamera(resolved);
      viewer.setFocus(modelToContent(resolved.focus), { snap: true, recentre: false });
      lastConvergence = Number.NaN;
      pushViewRig(true);
    } else {
      if (viewer.mono.capture) viewer.useDisplayCamera();
      if (bounds) viewer.fitTo(bounds.center, bounds.extent);
      else console.warn('[inline3d/splat] no usable bounds — subject is UNFRAMED (model scale)', src);
      if (resolved.focusSource === 'caller' || resolved.focusSource === 'block') {
        viewer.setFocus(modelToContent(resolved.focus), { snap: true, recentre: true });
      }
    }
    return { pickCentres, alpha8: cloud?.alpha8 || null };
  }

  let pcModule = null;
  const booted = (async () => {
    const pc = opts.playcanvas || (await import('playcanvas'));
    if (removed) return null;
    const app = await viewer.attachEngine(pc, {
      preserveDrawingBuffer,
      perf: perfResolved,
      viewPath: opts.playcanvasViewPath,
    });
    if (!app || removed) return null;
    pcModule = pc;
    /**
     * ADVANCED, not covered by the semver promise: the engine objects behind this window.
     * `app` is the tile's `pc.AppBase`; `root` the content root, in the splat's content space
     * (engine world) — add your own entities under it (a glTF through the engine's container
     * loader, skinned and animated included); `camera` the eye-rig camera entity. Everything is
     * destroyed with the app by `remove()`.
     */
    out.engine = Object.freeze({ app, root: viewer.content, camera: viewer.eye || null });
    return app;
  })();

  const first = booted.then(async (app) => {
    if (!app || removed) return null;
    const loaded = await loadOne(pcModule, app, src);
    if (removed) return null;
    const entity = viewer.addSplatAsset(loaded.asset);
    out.mesh = {
      numSplats: loaded.desc.numSplats || loaded.cloud?.sourceTotal || 0,
      entity,
      asset: loaded.asset,
      resource: loaded.res,
    };
    const kept = applyLoaded(loaded);
    current = { asset: loaded.asset, entity, res: loaded.res, kind: loaded.desc.kind, ...kept };
    bindFocusInput();
    return out;
  });

  // ── setSource: swap the asset, optionally crossfading ──
  let sourceGen = 0;
  let pendingSwap = null;
  /**
   * Load `next` behind the current asset, then crossfade to it over `fadeMs` and release the old
   * one. The rig waterfall re-runs for the new file (rig, lens, focus, frame; `onFocusChange`
   * fires). The pose (yaw/pitch/zoom/depth) is kept unless `resetPose: true`. A newer call
   * supersedes an older one still loading. Resolves to the handle once the fade has finished.
   */
  async function setSource(next, { fadeMs = 0, resetPose = false } = {}) {
    const gen = ++sourceGen;
    const app = await booted;
    await first.catch(() => null); // a failed first asset may be replaced
    if (!app || removed) return out;
    const pc = pcModule;
    const loaded = await loadOne(pc, app, next);
    if (removed || gen !== sourceGen) {
      app.assets.remove(loaded.asset);
      loaded.asset.unload?.();
      return out;
    }
    const prev = current;
    const entity = viewer.addSplatAsset(loaded.asset);
    const fade = Number.isFinite(fadeMs) && fadeMs > 0 ? fadeMs : 0;
    if (fade && prev) setFade(pc, entity, 0);
    out.mesh = {
      numSplats: loaded.desc.numSplats || loaded.cloud?.sourceTotal || 0,
      entity,
      asset: loaded.asset,
      resource: loaded.res,
    };
    const kept = applyLoaded(loaded);
    current = { asset: loaded.asset, entity, res: loaded.res, kind: loaded.desc.kind, ...kept };
    if (resetPose) viewer.resetPose();

    const release = () => {
      if (!prev) return;
      // Disable first, destroy + unload a few frames LATER: the engine's gsplat world keeps the
      // old placement in its list until its next rebuild, and tearing the resource down in the
      // same frame throws inside the engine's update (found by running the swap).
      prev.entity.enabled = false;
      let frames = 0;
      viewer._hooks.push(() => {
        if (++frames < 4) return true;
        prev.entity.destroy?.();
        app.assets.remove(prev.asset);
        prev.asset.unload?.();
        return false;
      });
    };
    if (!fade || !prev) {
      release();
      return out;
    }
    pendingSwap?.finish();
    await new Promise((resolve) => {
      // The fade clock starts on the SECOND tick after the swap, not now: the first frame that
      // draws the new asset also builds its work buffer (hundreds of ms for a 1M-splat file), and
      // a clock started before it would spend the whole fade inside that one frame — a cut, not a
      // crossfade (found by screenshotting mid-fade).
      let t0 = null;
      let ticks = 0;
      const finish = () => {
        setFade(pc, entity, null);
        release();
        pendingSwap = null;
        resolve();
      };
      pendingSwap = { finish };
      setFade(pc, prev.entity, 1);
      viewer._hooks.push((t) => {
        if (removed) return (resolve(), false);
        if (pendingSwap?.finish !== finish) return false; // superseded: already finished
        if (++ticks < 2) return true;
        if (t0 === null) t0 = t;
        const k = Math.min(1, Math.max(0, (t - t0) / fade));
        setFade(pc, entity, k);
        setFade(pc, prev.entity, 1 - k);
        if (k >= 1) {
          finish();
          return false;
        }
        return true;
      });
    });
    return out;
  }

  // The load promise is RETURNED, never written to `out.ready`: ./splat's addSplat owns that
  // field (one promise, one owner).
  return first
    .then((r) => r || out)
    .catch((err) => {
      console.warn('[inline3d/splat] failed to load (engine:playcanvas)', src, err);
      throw err;
    });
}

let byteSeq = 0;

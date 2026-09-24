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
import { boundsFromPositions, boundsFromPositionsAsync } from './inline3d-viewer.js';
import { cameraRigFromPose, displayRig } from './inline3d-three.js';
import {
  SplatEffects,
  EFFECTS,
  EASINGS,
  resolveRevealOption,
  resolveEffectOptions,
  validateEffectCall,
  PARTICLE_TRANSITIONS,
  PARTICLE_TRANSITION_OPTIONS,
  particleSpan,
} from './inline3d-splat-effects.js';
import { LiveOutgoing, resolveOutgoingOption, defaultOutgoing, yieldIdle } from './inline3d-splat-live.js';
import { VideoPlane, validateSetVideo, PAGE_VIDEO_ERROR } from './inline3d-splat-video.js';
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
  ZOOM_WHEEL_IDLE_MS,
  ZOOM_RELAX_MIN_RATE,
  resolveZoomOption,
  MONO_FOV,
  MONO_NEAR,
  MONO_FAR,
  CAPTURE_FAR,
  captureWindow,
  captureVerticalFovDeg,
  engineFormatFor,
  pathOf,
  streamedBytesError,
  resolveControls,
  normalizeCameraPose,
  coverageExponent,
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

const PAGE_POSE_ERROR =
  "@displayxr/inline3d/splat: setPose()/resetPose() are not available with controls:'page' — the " +
  'page owns the camera. Drive it with handle.setCameraPose(matrixWorld, { verticalFovDeg, near, far }).';

const DEG = Math.PI / 180;

/** Tone-mapping names the viewer takes → the engine's constant names. */
export const TONE_MAPPINGS = Object.freeze({
  none: 'TONEMAP_NONE',
  linear: 'TONEMAP_LINEAR',
  neutral: 'TONEMAP_NEUTRAL',
  aces: 'TONEMAP_ACES',
  aces2: 'TONEMAP_ACES2',
  filmic: 'TONEMAP_FILMIC',
  hejl: 'TONEMAP_HEJL',
});

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
 * controls:'page' — the rig node's TRS from the page's camera matrix.
 *
 * `matrixWorld` is the page camera's world matrix in the SPLAT's model space (the space of the
 * `.sog` camera block's `rest`), a three.js-convention camera (looks down −Z, +Y up). The splat
 * entity carries the OpenCV → GL half-turn about X under `flipY`, so the camera rides the same
 * turn: rig = F · M, F = Rx(180°) (or the identity without the flip). A uniform scale in M is
 * kept — it is how a page whose world scales the splat (F1000: S(2.5)) expresses "page units",
 * and it puts the runtime's eye offsets (metres) and the page's near/far into page units for free.
 *
 * @returns {{position:number[], rotation:number[], scale:number, uniform:boolean}}
 */
export function pageRigTRS(M, flipY = true) {
  const m = Float64Array.from(M);
  if (flipY) {
    for (const c of [0, 4, 8, 12]) {
      m[c + 1] = -m[c + 1];
      m[c + 2] = -m[c + 2];
    }
  }
  const len = (c) => Math.hypot(m[c], m[c + 1], m[c + 2]);
  const lx = len(0), ly = len(4), lz = len(8);
  const s = Math.cbrt(lx * ly * lz);
  const uniform = Math.abs(lx - s) < 1e-4 * s && Math.abs(ly - s) < 1e-4 * s && Math.abs(lz - s) < 1e-4 * s;
  const R = new Float64Array(16);
  R[0] = m[0] / lx; R[1] = m[1] / lx; R[2] = m[2] / lx;
  R[4] = m[4] / ly; R[5] = m[5] / ly; R[6] = m[6] / ly;
  R[8] = m[8] / lz; R[9] = m[9] / lz; R[10] = m[10] / lz;
  R[15] = 1;
  return { position: [m[12], m[13], m[14]], rotation: quatFromMatrix(R), scale: s, uniform };
}

/** pageRigTRS as a column-major matrix (the pick ray and the tests read it this way). */
export function pageRigMatrix(M, flipY = true) {
  const t = pageRigTRS(M, flipY);
  const out = poseMatrix(t.position, t.rotation);
  for (let i = 0; i < 12; i++) if (i % 4 !== 3) out[i] *= t.scale;
  return out;
}

/**
 * The page camera's view axis in MODEL space: its position and unit forward (−Z of the matrix),
 * plus the matrix's uniform scale (model units per page unit).
 */
export function pageViewAxis(M) {
  const s = Math.cbrt(Math.hypot(M[0], M[1], M[2]) * Math.hypot(M[4], M[5], M[6]) * Math.hypot(M[8], M[9], M[10]));
  const fl = Math.hypot(M[8], M[9], M[10]) || 1;
  return { origin: [M[12], M[13], M[14]], forward: [-M[8] / fl, -M[9] / fl, -M[10] / fl], scale: s };
}

/**
 * The attach-pattern camera rig for controls:'page' — the auto-3D shim's buildRig, field for
 * field: identity pose, the page's vertical FOV, convergence d, metersToVirtual = depth · d / 0.5
 * (so comfort = ipd × m2v × (1/d) × 0.5 = depth by construction).
 */
export function pageViewRig({ verticalFovDeg, convergence, comfortDepth, ipdFactor = 1, parallaxFactor = 1 }, out = {}) {
  const d = Math.max(1e-6, convergence);
  return cameraRigFromPose(
    { fov: verticalFovDeg },
    { attach: true, convergence: d, ipdFactor, parallaxFactor, metersToVirtual: (comfortDepth * d) / 0.5, out },
  );
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
 * The rewritten lines are adapted from PlayCanvas engine src/scene/shader-lib/glsl/chunks/gsplat/vert/
 * gsplatCorner.js (the `gsplatCornerVS` chunk) @ v2.22.3, MIT (THIRD_PARTY_NOTICES.md).
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
      zoom,
      feather = 0,
      captureFit = 'height',
      nearClip,
      farClip,
      sky = false,
      pageCamera = false,
      toneMapping = 'none',
    } = opts;
    this.canvas = canvas;
    // controls:'page': the PAGE owns the camera (setPageCamera). No orbit, no idle, no fit; the
    // rig node carries the page's matrix instead of the inverse pivot.
    this.pageCamera = pageCamera === true;
    this.page = this.pageCamera
      ? { matrix: poseMatrix([0, 0, 0], [0, 0, 0, 1]), fov: MONO_FOV, near: MONO_NEAR, far: CAPTURE_FAR, set: false }
      : null;
    // The engine draws a sky box whenever the scene has something to draw it from — and
    // `scene.envAtlas` counts: a page that sets one to light its own meshes under
    // handle.engine.root got a grey gradient box behind the splat the instant the splat was
    // hidden (mid-setSource, or a page showing only its meshes). The SDK's contract is a
    // transparent canvas the page shows through, so the sky layer is off unless asked for.
    this.sky = sky === true;
    // The eye camera's tone mapping, by name (the engine constant is looked up once the engine has
    // loaded). 'none' for splats — their colours are already display-referred; ./model's mesh
    // tiles pass 'neutral' (Khronos PBR Neutral), the glTF Sample Viewer's default.
    this.toneMapping = toneMapping;
    this.sceneColor = false;
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
    // Zoom bounds + relax (./inline3d-splat-shared.js §ZOOM). Wheel and pinch clamp to
    // [zoomOpts.min, zoomOpts.max]; with relax, the zoom eases back to `_restZoom` (1×, or the
    // last setPose zoom) once the wheel is idle or the pinch ends. `_zoomMode` is 'rest' while
    // relaxing, else null (the ordinary damping). `_pinching` holds the relax off.
    this.zoomOpts = resolveZoomOption(zoom);
    this._zoomMode = null;
    this._restZoom = clamp(1, this.zoomOpts.min, this.zoomOpts.max);
    this._lastWheel = 0;
    this._pinching = false;
    /** handle.setVideo: orbit/zoom input ignored while a video plane is on. */
    this.inputLocked = false;
    /** handle.setVideo's plane (./inline3d-splat-video.js) while a video is on, else null. */
    this._videoPlane = null;
    this.boxAspect = 1;
    this.featherPx = feather > 0 ? feather : 0;
    this.captureFit = captureFit;
    /** Called when the capture camera's vertical FOV changes (captureFit 'cover' on a resize). */
    this.onCaptureFov = null;
    /** Per-frame hooks, `(tMs) => boolean` — return false to be removed. setSource's crossfade. */
    this._hooks = [];
    /** captureFrame() callers waiting for the next drawn frame. */
    this._captureWaiters = [];
    /** The crossfade's frame snapshot: { w, h, tex, rt, mi, mat } once captured. */
    this._snap = null;
    /** setSource's live outgoing asset (./inline3d-splat-live.js), made on first use. */
    this._live = null;
    this.vH = virtualDisplayHeight;
    this.fit = fit;
    this.margin = margin;
    this.depthLimit = depthLimit;
    this.fitSweep = fitSweep;
    this.renderScale = renderScale;
    this.pitchLimit = pitchLimit;
    this.idleSpin = this.pageCamera ? 0 : idleSpin;
    this.flipY = opts.flipY !== false;

    this._fitScale = 1;
    this._zoom = this._restZoom;
    this._targetZoom = this._restZoom;
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
    /** controls:'page' — `(views|null) => void`, run once per frame before anything else. */
    this._beforeFrame = null;
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
    if (this.pageCamera) {
      // The mono camera IS the page camera: identity under the rig node, the page's lens.
      this.mono.fov = this.page.fov;
      this.mono.near = this.page.near;
      this.mono.far = this.page.far;
      this.mono.pose = poseMatrix([0, 0, 0], [0, 0, 0, 1]);
    }
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

    if (orbit && !this.pageCamera) this._bindOrbit();
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
    if (this.pageCamera) return; // the page frames its own camera
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
    if (this.pageCamera) throw new Error(PAGE_POSE_ERROR);
    // A snap, as on SceneViewer; it also ends an orbit relax (the page is driving now).
    if (yaw !== undefined || pitch !== undefined) this._orbitMode = null;
    if (yaw !== undefined) this._targetYaw = this._yaw = yaw;
    if (pitch !== undefined) {
      this._targetPitch = this._pitch = clamp(pitch, this.pitchLimit[0], this.pitchLimit[1]);
    }
    if (zoom !== undefined) {
      // A snap, and the new rest: a relax comes home HERE, not to 1×.
      this._targetZoom = this._zoom = this._restZoom = clamp(zoom, this.zoomOpts.min, this.zoomOpts.max);
      this._zoomMode = null;
    }
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
    if (this.pageCamera) throw new Error(PAGE_POSE_ERROR);
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

  /**
   * controls:'page' — take the page's camera for the next frame drawn (last call wins; no call
   * keeps the last pose). `pose` is normalizeCameraPose()'s output. The rig node is written here
   * and by the tick, through _applyTransform (still its only writer).
   */
  setPageCamera(pose) {
    if (!this.pageCamera) throw new Error("setPageCamera needs controls:'page'");
    const p = this.page;
    p.matrix.set(pose.matrixWorld);
    p.set = true;
    if (pose.verticalFovDeg !== p.fov || pose.near !== p.near || pose.far !== p.far) {
      p.fov = pose.verticalFovDeg;
      p.near = pose.near;
      p.far = pose.far;
      this.mono.fov = p.fov;
      this.mono.near = p.near;
      this.mono.far = p.far;
      this._updateMonoProjection();
    }
    this._applyTransform();
  }

  /**
   * The rig node's matrix (eye space → content space): the inverse pivot on the viewer's own
   * controls, F · matrixWorld on controls:'page'.
   */
  rigMatrix() {
    if (this.pageCamera) return pageRigMatrix(this.page.matrix, this.flipY);
    return mat4Invert(pivotMatrix(this.pivotState()));
  }

  /** Pose + lens the mono camera as the recording camera (applyCaptureCamera's counterpart). */
  useCaptureCamera(rig) {
    if (this.pageCamera) return; // the page's lens, not the recording's
    const pose = capturePose(rig.rest, this.flipY);
    this.mono.pose = pose.matrix;
    this.mono.capture = rig.intrinsics;
    this.mono.fov = captureVerticalFovDeg(rig.intrinsics, NaN, this.mono.near, 'height');
    this.mono.far = Math.max(this.mono.far, CAPTURE_FAR);
    this._updateMonoProjection();
  }

  /**
   * Switch the eye camera(s) to another tone mapping, by name (TONE_MAPPINGS). Live: the engine
   * picks the new shader variant on the next draw. handle.setRig's display rig uses it to give a
   * page's meshes addModel's 'neutral' while the splat is hidden.
   */
  setToneMapping(name) {
    const key = TONE_MAPPINGS[name] ? name : 'none';
    this.toneMapping = key;
    const pc = this.pc;
    if (!pc) return;
    const v = pc[TONE_MAPPINGS[key]] ?? pc.TONEMAP_NONE;
    if (this.eye?.camera) this.eye.camera.toneMapping = v;
    if (this._viewPath === 'cameras') for (const c of this._views) if (c?.camera) c.camera.toneMapping = v;
  }

  /**
   * Turn the scene-colour grab pass on (true) or off on every eye camera — what a
   * KHR_materials_transmission material samples (./model's prepareTransmission). Idempotent: the
   * engine's `renderSceneColorMap` setter counts one request per camera. Cameras made later (a
   * view-path switch) inherit it via `_makeCamera`.
   */
  useSceneColor(on = true) {
    this.sceneColor = !!on;
    const cams = [this.eye, ...(this._viewPath === 'cameras' ? this._views : [])];
    for (const c of cams) if (c?.camera && c.camera.renderSceneColorMap !== undefined) c.camera.renderSceneColorMap = this.sceneColor;
  }

  /** Forget the auto-fit (scale 1, no subject box) — the camera rig's framing. */
  resetFit() {
    this._fitScale = 1;
    this._subjectHalf = [0, 0, 0];
    this._applyTransform();
  }

  /** Back to the display rig's mono camera (setSource from a photo lift to an object). */
  useDisplayCamera() {
    if (this.pageCamera) return;
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
    // BEFORE the tick: a pose the page sets in here is the one this very frame renders.
    this._beforeFrame?.(views || null);
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
      this._beforeFrame?.(null);
      if (this._disposed || this._mode !== 'mono') return; // the callback removed or re-wove us
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
    for (const w of this._captureWaiters.splice(0)) {
      clearTimeout(w.timer);
      w.resolve(false);
    }
    this._live?.destroy();
    this._live = null;
    this._videoPlane?.destroy();
    this._videoPlane = null;
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
  async attachEngine(pc, { preserveDrawingBuffer = false, perf, viewPath, antialias = false, patchSplats = true } = {}) {
    this.pc = pc;
    const device = await pc.createGraphicsDevice(this.canvas, {
      deviceTypes: [pc.DEVICETYPE_WEBGL2],
      alpha: true,
      premultipliedAlpha: true,
      // Off for splats (alpha-blended quads gain nothing from MSAA); ./model turns it on, as
      // three's SceneViewer has it, because mesh silhouettes alias visibly without it.
      antialias,
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
    // ./model passes patchSplats:false: its subject is a mesh, and a page adding a splat under
    // handle.engine.root on a model tile gets the engine's stock footprint (documented).
    const chunks = patchSplats ? pc.ShaderChunks.get(device, pc.SHADERLANGUAGE_GLSL) : null;
    const corner = chunks ? patchGsplatFootprint(chunks.get('gsplatCornerVS')) : { ok: false, skipped: true };
    if (corner.ok) chunks.set('gsplatCornerVS', corner.src);
    else if (!corner.skipped && !warnedFootprint) {
      warnedFootprint = true;
      console.warn(
        '[inline3d/splat] engine:playcanvas — this engine build does not have the gsplatCornerVS ' +
          'lines the non-square-pixel footprint fix rewrites, so it is SKIPPED: side-by-side ' +
          'splats will draw at half height (vertical stipple). Report the engine version; the ' +
          'anchors are in js/inline3d-splat-playcanvas.js.',
      );
    }
    this.footprintPatched = corner.ok;
    if (chunks && perf?.quadExtent) {
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

  /**
   * Copy the frame just drawn (the whole buffer: both eyes in 3D) into a texture, on the next
   * drawn frame. Resolves true once copied, false if no frame is drawn within `timeoutMs` (a
   * hidden tab) or the engine cannot copy. setSource's crossfade (FRAME_SNAPSHOT).
   */
  captureFrame(timeoutMs = 250) {
    return new Promise((resolve) => {
      if (!this.app || this._disposed || !this.pc?.RenderTarget) return resolve(false);
      const waiter = { resolve, timer: 0 };
      waiter.timer = setTimeout(() => {
        const i = this._captureWaiters.indexOf(waiter);
        if (i >= 0) this._captureWaiters.splice(i, 1);
        resolve(false);
      }, timeoutMs);
      this._captureWaiters.push(waiter);
    });
  }

  _doCapture() {
    const run = this._captureWaiters.splice(0);
    let ok = false;
    try {
      const pc = this.pc;
      const device = this.app.graphicsDevice;
      const w = this.canvas.width;
      const h = this.canvas.height;
      let s = this._snap;
      if (!s || !s.tex || s.w !== w || s.h !== h) {
        // A new size, or the texture was released after the last transition: a new texture.
        // The overlay quads (and their compiled materials) are kept.
        const parts = s?.parts || null;
        s?.rt?.destroy?.();
        s?.tex?.destroy?.();
        const tex = new pc.Texture(device, {
          name: 'inline3d-snapshot',
          width: w,
          height: h,
          format: pc.PIXELFORMAT_RGBA8,
          mipmaps: false,
          minFilter: pc.FILTER_NEAREST,
          magFilter: pc.FILTER_NEAREST,
          addressU: pc.ADDRESS_CLAMP_TO_EDGE,
          addressV: pc.ADDRESS_CLAMP_TO_EDGE,
        });
        s = this._snap = { w, h, tex, rt: new pc.RenderTarget({ colorBuffer: tex, depth: false }), parts };
      }
      // null source = the back buffer, still holding this frame (same task, before compositing).
      ok = device.copyRenderTarget(null, s.rt, true, false) !== false;
      if (ok) this._ensureSnapshotOverlay();
    } catch (err) {
      console.warn('[inline3d/splat] frame snapshot failed; the crossfade falls back to one pass', err);
      ok = false;
    }
    for (const w of run) {
      clearTimeout(w.timer);
      w.resolve(ok);
    }
  }

  /**
   * FRAME_SNAPSHOT: the captured frame lerped with the live scene, in two clip-space quads in the
   * UI layer (under the edge feather), drawn once per view like the feather. Each samples the
   * capture at gl_FragCoord, so an eye's viewport reads its own half. Quad 1 scales what the scene
   * drew by (1 − α) (blend ZERO / SRC_ALPHA, colour AND alpha); quad 2 adds α·A (ONE / ONE). The
   * result is the plain lerp of the two premultiplied images, `α·A + (1 − α)·B` — alpha included,
   * so a region only one of the two photos covers fades against the page, not against black.
   */
  _ensureSnapshotOverlay() {
    const s = (this._snap ||= { w: 0, h: 0, tex: null, rt: null, parts: null }); // prewarm: no capture yet
    if (s.parts) {
      if (!s.tex) return;
      for (const p of s.parts) {
        p.mat.setParameter('dxrSnap', s.tex);
        p.mat.setParameter('dxrSnapInvSize', [1 / s.w, 1 / s.h]);
        p.mat.update();
      }
      return;
    }
    const pc = this.pc;
    const mesh = new pc.Mesh(this.app.graphicsDevice);
    mesh.setPositions(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]));
    mesh.setIndices([0, 1, 2, 0, 2, 3]);
    mesh.update();
    const part = (name, body, src, dst, drawOrder) => {
      const mat = new pc.ShaderMaterial({
        uniqueName: name,
        attributes: { vertex_position: pc.SEMANTIC_POSITION },
        vertexGLSL: `
        attribute vec3 vertex_position;
        void main() { gl_Position = vec4(vertex_position.xy, 0.0, 1.0); }`,
        fragmentGLSL: `
        uniform sampler2D dxrSnap;
        uniform vec2 dxrSnapInvSize;
        uniform float dxrSnapAlpha;
        uniform vec3 dxrSnapWipe; // t, band, views across (t < -1: no wipe)
        uniform float dxrSnapOver; // 0 = lerp, 1 = A OVER the scene (the particle transitions)
        float dxrSnapWeight() {
          if (dxrSnapWipe.x < -1.0) return dxrSnapAlpha;
          float vw = 1.0 / (dxrSnapInvSize.x * dxrSnapWipe.z);
          float u = mod(gl_FragCoord.x, vw) / vw;
          // wavefrontCommit(): column u has committed lt of the way to the new photo
          float lt = clamp((dxrSnapWipe.x - u * (1.0 - dxrSnapWipe.y)) / dxrSnapWipe.y, 0.0, 1.0);
          return dxrSnapAlpha * (1.0 - smoothstep(0.0, 1.0, lt));
        }
        void main() { ${body} }`,
      });
      mat.blendState = new pc.BlendState(true, pc.BLENDEQUATION_ADD, src, dst, pc.BLENDEQUATION_ADD, src, dst);
      mat.depthTest = false;
      mat.depthWrite = false;
      mat.cull = pc.CULLFACE_NONE;
      if (s.tex) {
        mat.setParameter('dxrSnap', s.tex);
        mat.setParameter('dxrSnapInvSize', [1 / s.w, 1 / s.h]);
      }
      mat.setParameter('dxrSnapAlpha', 0);
      mat.setParameter('dxrSnapWipe', [-2, 0.1, 1]);
      mat.setParameter('dxrSnapOver', 0);
      mat.update();
      const mi = new pc.MeshInstance(mesh, mat, new pc.GraphNode(name));
      mi.cull = false;
      mi.drawOrder = drawOrder; // both before the edge feather (drawOrder 0)
      mi.visible = false;
      return { mat, mi };
    };
    s.parts = [
      // lerp: dst·(1 − w); over: dst·(1 − w·A.a) — premultiplied A over the scene
      part(
        'inline3dSnapshotScale',
        'float w = dxrSnapWeight(); float a = texture2D(dxrSnap, gl_FragCoord.xy * dxrSnapInvSize).a; gl_FragColor = vec4(0.0, 0.0, 0.0, mix(1.0 - w, 1.0 - w * a, dxrSnapOver));',
        pc.BLENDMODE_ZERO,
        pc.BLENDMODE_SRC_ALPHA,
        -2,
      ),
      part('inline3dSnapshotAdd', 'gl_FragColor = texture2D(dxrSnap, gl_FragCoord.xy * dxrSnapInvSize) * dxrSnapWeight();', pc.BLENDMODE_ONE, pc.BLENDMODE_ONE, -1),
    ];
    this.app.scene.layers.getLayerById(pc.LAYERID_UI).addMeshInstances(s.parts.map((p) => p.mi));
  }

  /**
   * Lerp the snapshot over the scene at `alpha` (0 hides it). Returns false when the canvas buffer
   * no longer matches the capture (resize, 2D/3D switch): the caller ends its fade.
   */
  setSnapshotAlpha(alpha, wipe = null, mix = null) {
    const s = this._snap;
    if (!s?.parts) return false;
    const fits = !!s.tex && s.w === this.canvas.width && s.h === this.canvas.height;
    const show = alpha > 0 && fits;
    for (const p of s.parts) {
      p.mi.visible = show;
      if (show) {
        p.mat.setParameter('dxrSnapAlpha', Math.min(1, alpha));
        // WIPE (setSource's wavefront): the frozen frame gives way behind a vertical front at the
        // SAME viewport-relative x in every eye — a front at the zero-disparity plane, so both
        // eyes agree. `views` = eye viewports side by side across the buffer.
        p.mat.setParameter('dxrSnapWipe', wipe ? [wipe.t, wipe.band, wipe.views] : [-2, 0.1, 1]);
        // setSource's particle transitions: the live outgoing image OVER the incoming one
        p.mat.setParameter('dxrSnapOver', mix?.over ? 1 : 0);
        p.mat.update();
      }
    }
    return alpha <= 0 || fits;
  }

  /**
   * The overlay's source: the live outgoing target, or null for the frozen capture. The same two
   * quads, the same lerp / wipe — only the texture changes.
   */
  setSnapshotSource(tex) {
    const s = this._snap;
    if (!s?.parts) return;
    for (const p of s.parts) {
      p.mat.setParameter('dxrSnap', tex || s.tex);
      p.mat.update();
    }
  }

  /**
   * The mono/capture camera as a lens frame, for the live outgoing's rig chain
   * (./inline3d-splat-live.js): the rig node's matrix, the camera pose in rig space, the
   * convergence distance c (along the view axis to the focus, which the pivot puts at the orbit
   * centre) and t = tan(vertical fov / 2).
   */
  lensFrame() {
    const pose = Float64Array.from(this.mono.pose);
    const o = this._orbitCentre;
    const fz = o.z + this._depthOffset;
    let c = -((o.x - pose[12]) * pose[8] + (o.y - pose[13]) * pose[9] + (fz - pose[14]) * pose[10]);
    if (!(c > 1e-6)) c = 1;
    return { rig: this.rigMatrix(), pose, c, t: Math.tan((this.mono.fov * DEG) / 2) };
  }

  /** Can this tile render a live outgoing asset (the single-camera RenderView path)? */
  get canLiveOutgoing() {
    return LiveOutgoing.supported(this);
  }

  /** Start rendering `entity` live into its own target (see ./inline3d-splat-live.js). */
  startLiveOutgoing(entity, oldFrame) {
    this._live ||= new LiveOutgoing(this);
    return this._live.start(entity, oldFrame) ? this._live : null;
  }

  /** End the live window: overlay back on the frozen capture, camera off, target freed. */
  stopLiveOutgoing() {
    if (!this._live?.active) return;
    this.setSnapshotSource(null);
    this._live.stop();
  }

  /**
   * A transition has ended: free the frozen frame's texture (7 MB at 2560×720; it used to stay
   * allocated until the next swap). The overlay quads stay, hidden; the next capture makes a new
   * texture.
   */
  releaseSnapshot() {
    const s = this._snap;
    if (!s?.tex) return;
    for (const p of s.parts || []) p.mi.visible = false;
    s.rt?.destroy?.();
    s.tex.destroy?.();
    s.rt = s.tex = null;
    s.w = s.h = 0;
  }

  /** How many eye viewports sit side by side in the buffer right now (1 in mono). */
  get viewsAcross() {
    return this._mode === '3d' && this._lastGood ? this._lastGood.entries.length : 1;
  }

  _destroySnapshot() {
    const s = this._snap;
    if (!s) return;
    this._snap = null;
    if (s.parts) {
      this.app?.scene?.layers?.getLayerById(this.pc.LAYERID_UI)?.removeMeshInstances?.(s.parts.map((p) => p.mi));
      s.parts[0].mi.mesh?.destroy?.();
    }
    s.rt?.destroy?.();
    s.tex?.destroy?.();
  }

  /** Read back what the tick just did. Cheap: two numbers off the renderer. */
  _afterTick() {
    if (this._captureWaiters.length) this._doCapture();
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
    e.camera.toneMapping = TONE_MAPPINGS[this.toneMapping] ? pc[TONE_MAPPINGS[this.toneMapping]] ?? pc.TONEMAP_NONE : pc.TONEMAP_NONE;
    if (this.sceneColor) e.camera.renderSceneColorMap = true;
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
    if (this.mono.capture || this.pageCamera) return;
    const d = (0.5 * this.vH) / Math.tan((this.mono.fov * DEG) / 2);
    this.mono.pose = poseMatrix([0, 0, d], [0, 0, 0, 1]);
  }

  _updateMonoProjection() {
    const box = this.canvas.getBoundingClientRect();
    const aspect = box.height > 0 ? box.width / box.height : 1;
    this.boxAspect = aspect; // setVideo's plane reads it per frame (no layout read in the draw)
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
    if (this.pageCamera) {
      // The page's near/far join the caller's nearClip/farClip as a floor and a cap: only the
      // depth mapping moves, the runtime's frustum (fov, skew, principal point) stays untouched.
      const p = this.page;
      const nf = this.nearClip !== null ? Math.max(this.nearClip, p.near) : p.near;
      const fc = this.farClip !== null ? Math.min(this.farClip, p.far) : p.far;
      for (const e of entries) clampProjectionDepth(e.proj, nf, fc);
    } else if (this.nearClip !== null || this.farClip !== null) {
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
      // setSource's live outgoing: the same views on its own camera, into its own target.
      if (this._live?.active) this._live.sync(entries, rect, f);
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
    // handle.setVideo's plane: size, eye split, and a new frame's upload (./inline3d-splat-video.js).
    this._videoPlane?.beforeDraw(entries, rect);
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
    // Zoom relax: the wheel has gone idle (or the pinch ended) away from rest — head home.
    if (
      this.zoomOpts.relax &&
      !this._zoomMode &&
      !this._pinching &&
      t - this._lastWheel > ZOOM_WHEEL_IDLE_MS &&
      Math.abs(this._targetZoom - this._restZoom) > 1e-6
    ) {
      this._targetZoom = this._restZoom;
      this._zoomMode = 'rest';
    }
    // Relaxing eases with τ = zoomOpts.ease (the orbit's 0.6 s by default); the wheel's own
    // damping otherwise. Both in log space, so 2× → 1× reads like 1× → ½×.
    if (this._zoomMode === 'rest') {
      // The exponential (τ = zoomOpts.ease) with a landing floor: it never moves slower than
      // ZOOM_RELAX_MIN_RATE (log-zoom per second), so it ARRIVES — 2× is home in ≈3 s — instead of
      // creeping in forever or popping at a snap. Above ~1 % from home the floor never binds.
      const gap = Math.log(this._targetZoom / this._zoom);
      const ko = dt > 0 ? 1 - Math.exp(-dt / this.zoomOpts.ease) : 0;
      const step = Math.min(Math.abs(gap), Math.max(Math.abs(gap) * ko, ZOOM_RELAX_MIN_RATE * dt));
      if (Math.abs(gap) - step < 1e-6) {
        this._zoom = this._targetZoom;
        this._zoomMode = null;
      } else {
        this._zoom *= Math.exp(Math.sign(gap) * step);
      }
    } else if (Math.abs(this._targetZoom - this._zoom) > 1e-4) {
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
    // Splat effects (./inline3d-splat-effects.js): clocks + uniforms, before the engine renders.
    this.onEffectsTick?.(t);
    this.onTick?.();
  }

  /**
   * The eyes' frame in WORLD (content) space, for effects keyed on "where the viewer is":
   * `origin` = the midpoint of the eyes drawn last (the mono camera in 2D), `axis`/`right`/`up` =
   * the first eye's forward/right/up, `tanHalfFovX` / `tanHalfFovY` its lens half-extents.
   */
  eyeFrame() {
    const R = this.rigMatrix();
    const es = this._mode === '3d' && this._lastGood ? this._lastGood.entries : [{ pose: this.mono.pose, proj: this.mono.proj }];
    const o = [0, 0, 0];
    for (const e of es) {
      const M = mat4Mul(R, e.pose);
      o[0] += M[12] / es.length;
      o[1] += M[13] / es.length;
      o[2] += M[14] / es.length;
    }
    const M = mat4Mul(R, es[0].pose);
    const unit = (x, y, z) => {
      const l = Math.hypot(x, y, z) || 1;
      return [x / l, y / l, z / l];
    };
    const p0 = es[0].proj?.[0];
    const Mn = mat4Mul(R, es[es.length - 1].pose);
    return {
      origin: o,
      // first ↔ last eye, world units (0 in 2D)
      separation: es.length > 1 ? Math.hypot(Mn[12] - M[12], Mn[13] - M[13], Mn[14] - M[14]) : 0,
      axis: unit(-M[8], -M[9], -M[10]),
      right: unit(M[0], M[1], M[2]),
      up: unit(M[4], M[5], M[6]),
      tanHalfFovX: p0 > 0 ? 1 / p0 : 0.5,
      tanHalfFovY: es[0].proj?.[5] > 0 ? 1 / es[0].proj[5] : 0,
    };
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
    const trs = this.pageCamera ? pageRigTRS(this.page.matrix, this.flipY) : pivotInverseTRS(this.pivotState());
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
    // Pinch: two pointers down zoom by the ratio of their spread, about the focus (the pivot's
    // scale is S(fit × zoom) about it), within zoomOpts' bounds. The drag ends when the second
    // finger lands (its tilt relaxes); the finger left after a pinch does not orbit.
    const pointers = new Map(); // pointerId → [clientX, clientY]
    let pinchD0 = 0;
    let pinchZ0 = 1;
    const spread = () => {
      const [a, b] = [...pointers.values()];
      return Math.hypot(a[0] - b[0], a[1] - b[1]);
    };
    const endDrag = () => {
      dragging = false;
      this._targetYaw = restYaw;
      this._targetPitch = clamp(restPitch, this.pitchLimit[0], this.pitchLimit[1]);
      this._orbitMode = 'rest';
    };
    this._onDown = (ev) => {
      if (this.inputLocked) return; // handle.setVideo: a screen-locked plane has nothing to orbit
      if (ev.pointerId !== undefined) pointers.set(ev.pointerId, [ev.clientX, ev.clientY]);
      try {
        el.setPointerCapture?.(ev.pointerId);
      } catch {
        // An inactive pointer id (a synthetic event) throws; the gesture works without capture.
      }
      if (pointers.size === 2) {
        if (dragging) endDrag();
        this._pinching = true;
        this._zoomMode = null; // a new gesture takes over from a relax
        pinchD0 = Math.max(spread(), 1);
        pinchZ0 = this._zoom;
        this._targetZoom = this._zoom;
        this._lastInput = now();
        return;
      }
      if (pointers.size > 2) return;
      dragging = true;
      startX = ev.clientX;
      startY = ev.clientY;
      // Rest = where the pose was heading when pressed (an idle turntable's yaw included).
      restYaw = this._orbitMode ? restYaw : this._targetYaw;
      restPitch = this._orbitMode ? restPitch : this._targetPitch;
      this._orbitMode = 'drag';
      this._lastInput = now();
    };
    this._onMove = (ev) => {
      if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, [ev.clientX, ev.clientY]);
      if (this._pinching) {
        if (pointers.size < 2) return;
        const { min, max } = this.zoomOpts;
        this._targetZoom = clamp(pinchZ0 * (spread() / pinchD0), min, max);
        this._lastInput = now();
        return;
      }
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
      const had = pointers.delete(ev.pointerId);
      if (this._pinching && pointers.size < 2) {
        // The pinch ends when either finger lifts: the zoom relaxes (zoomOpts.relax) from here.
        this._pinching = false;
        this._lastWheel = now() - ZOOM_WHEEL_IDLE_MS - 1;
        this._lastInput = now();
      }
      try {
        if (had || ev.pointerId === undefined) el.releasePointerCapture?.(ev.pointerId);
      } catch {
        // see pointerdown
      }
      if (!dragging) return;
      endDrag();
      this._lastInput = now();
    };
    this._onWheel = (ev) => {
      if (this.inputLocked) return;
      ev.preventDefault();
      let px = ev.deltaY;
      if (ev.deltaMode === 1) px *= WHEEL_LINE_PX;
      else if (ev.deltaMode === 2) px *= WHEEL_PAGE_PX;
      px = clamp(px, -WHEEL_MAX_PX, WHEEL_MAX_PX);
      // A wheel tick during a relax restarts from where the zoom IS, not from the rest target.
      const from = this._zoomMode === 'rest' ? this._zoom : this._targetZoom;
      this._zoomMode = null;
      this._targetZoom = clamp(from * Math.exp(-px * ZOOM_PER_PX), this.zoomOpts.min, this.zoomOpts.max);
      this._lastWheel = now();
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
    this._pinching = false;
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

export async function readCloud(resource, yielder = yieldToMain) {
  if (!resource) return null;
  const centers = resource.centers;
  const data = resource.gsplatData;
  const sourceTotal = data?.numSplats || (centers ? Math.floor(centers.length / 3) : 0);
  if (!centers || !sourceTotal) return null;
  const stride = Math.max(1, Math.ceil(sourceTotal / FRAME_SAMPLE_CAP));
  const total = Math.ceil(sourceTotal / stride);
  // Not in the task that delivered the asset: the engine's own end-of-load work (its centre
  // readback unpack) runs there, and stacking ours on it made one long task.
  await yielder();
  let t0 = performance.now();
  const xyz = new Float32Array(total * 3);
  for (let j = 0, i = 0; j < total; j++, i += stride) {
    xyz[j * 3] = centers[i * 3];
    xyz[j * 3 + 1] = centers[i * 3 + 1];
    xyz[j * 3 + 2] = centers[i * 3 + 2];
  }
  perfSpan('readCloud:copy', t0);
  await yielder();
  let opacity = null;
  // Full-resolution peak opacity, ONE BYTE per splat, kept for the exact pick (which walks the
  // engine's own full centre set at pick time): 1.18 MB on the 1.18M bench asset.
  let alpha8 = null;
  try {
    if (data?.isSog && data.sh0?.read) {
      t0 = performance.now();
      const px = await data.sh0.read(0, 0, data.sh0.width, data.sh0.height, { mipLevel: 0, face: 0, immediate: true });
      perfSpan('readCloud:sh0-readback(async)', t0);
      await yielder();
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
 * setSource's crossfade.
 *
 * The 1.11 fade multiplied each splat's alpha by t and drew both assets in ONE sorted pass. That
 * is not a crossfade: whichever photo sits in FRONT wins. Measured on SHARP photo pairs (the blend
 * fraction c, least squares of the frame between A-alone and B-alone): the incoming photo in front
 * reached c = 0.64 at t = 0.2 (a snap), behind it c = 0.18 at t = 0.5 (a late pop). No per-splat
 * alpha remap fixes that, because a pixel's coverage depends on how many splats stack there and
 * which asset is nearer — both vary across the picture and between photos (docs/splat-effects.md
 * §Crossfade has the numbers).
 *
 * FRAME_SNAPSHOT: blend IMAGES instead. The last frame of the outgoing asset (both eyes) is copied
 * into a texture, the outgoing asset is released at once, and the incoming one is drawn untouched;
 * two overlay quads then lerp the frozen frame with it, `out = (1 − t)·A + t·B` per premultiplied
 * pixel, alpha included (PlayCanvasSplatViewer._ensureSnapshotOverlay). Linear by construction,
 * whatever the depth order, coverage or framing; each eye samples its own half of the capture, so
 * the eyes stay consistent. End state: overlay hidden — exactly the untouched incoming asset.
 * Trade-offs: the outgoing frame is frozen for the fade (camera and head motion stop for it), and
 * the new asset's rig applies at once (each photo is seen through its own rig).
 *
 * Fallback (no frame drawn within 250 ms — a hidden tab — or no copy on this engine build): the
 * one-pass fade, with the coverage-linear alpha remap on both assets.
 */

/**
 * handle.setRig's DISPLAY-rig defaults: addModel's, so a mesh framed through setRig('display')
 * sits exactly where `addModel(url, { engine: 'playcanvas' })` puts it (docs/playcanvas-adapter.md
 * §setRig). `toneMapping` applies to the page's meshes while the splat is hidden (the splat keeps
 * 'none' whenever it is shown); `environment` installs addModel's IBL of the same name when the
 * page has no `scene.envAtlas` of its own, and removes it again when the rig changes back —
 * `'neutral'` (default, the Sample Viewer's studio) or `'room'` (three's RoomEnvironment; its
 * tone mapping defaults to `'none'`, three's, unless `toneMapping` is passed).
 */
export const SET_RIG_DISPLAY_DEFAULTS = Object.freeze({
  virtualDisplayHeight: 0.24,
  fit: 'contain',
  margin: 0.8,
  depthLimit: DEFAULT_DEPTH_LIMIT,
  fitSweep: true,
  idleSpin: 8,
  ipdFactor: 1,
  parallaxFactor: 1,
  perspectiveFactor: 1,
  toneMapping: 'neutral',
  environment: 'neutral',
});

/** The tone mapping each setRig environment defaults to (addModel's ENVIRONMENT_TONE_MAPPING). */
const SET_RIG_ENV_TONE_MAPPING = Object.freeze({ neutral: 'neutral', room: 'none', none: 'neutral' });

export const SET_RIG_TYPES = Object.freeze(['display', 'camera', 'auto']);
const SET_RIG_FITS = ['contain', 'cover', 'height', 'none'];
let warnedSetRigKeys = false;

const VIDEO_BUSY = (what) =>
  `@displayxr/inline3d/splat: ${what}() while a video is on — call handle.setVideo(null) first ` +
  '(the video holds the display rig and hides the splat until it exits).';

const PAGE_SETRIG_ERROR =
  "@displayxr/inline3d/splat: setRig() is not available with controls:'page' — the page owns the " +
  'camera (its camera IS the rig). Drive it with handle.setCameraPose(matrixWorld, { verticalFovDeg, near, far }).';

/**
 * handle.setRig's arguments, validated and resolved (throws at the call, before anything runs).
 * @returns {{type:'display'|'camera'|'auto', o?:object}}
 */
export function validateSetRig(type, o = {}, pageMode = false) {
  if (pageMode) throw new Error(PAGE_SETRIG_ERROR);
  if (!SET_RIG_TYPES.includes(type)) {
    throw new Error(`@displayxr/inline3d/splat: setRig("${type}") — expected 'display', 'camera' or 'auto'.`);
  }
  if (o === null || typeof o !== 'object') throw new TypeError('@displayxr/inline3d/splat: setRig options must be an object.');
  if (type !== 'display') return { type };
  const D = SET_RIG_DISPLAY_DEFAULTS;
  const known = new Set([...Object.keys(D), 'frame']);
  const unknown = Object.keys(o).filter((k) => !known.has(k));
  if (unknown.length && !warnedSetRigKeys) {
    warnedSetRigKeys = true;
    console.warn(
      `[inline3d/splat] setRig('display') ignores ${unknown.join(', ')}` +
        (unknown.includes('transitionMs') ? ' — a rig switch is a clean cut (no eased transition in this version)' : '') +
        '.',
    );
  }
  const num = (k, ok) => {
    const v = o[k] === undefined ? D[k] : o[k];
    if (!Number.isFinite(v) || !ok(v)) throw new Error(`@displayxr/inline3d/splat: setRig('display') — bad ${k}: ${o[k]}.`);
    return v;
  };
  const fit = o.fit === undefined ? D.fit : o.fit;
  if (!SET_RIG_FITS.includes(fit)) throw new Error(`@displayxr/inline3d/splat: setRig('display') — fit "${fit}", expected ${SET_RIG_FITS.join(' | ')}.`);
  const environment = o.environment === undefined ? D.environment : o.environment;
  if (!['room', 'neutral', 'none'].includes(environment)) {
    throw new Error(`@displayxr/inline3d/splat: setRig('display') — environment "${environment}", expected 'room' | 'neutral' | 'none'.`);
  }
  const toneMapping = o.toneMapping === undefined ? SET_RIG_ENV_TONE_MAPPING[environment] : o.toneMapping;
  if (!TONE_MAPPINGS[toneMapping]) {
    throw new Error(`@displayxr/inline3d/splat: setRig('display') — toneMapping "${toneMapping}", expected ${Object.keys(TONE_MAPPINGS).join(' | ')}.`);
  }
  let frame = null;
  if (o.frame != null) {
    const c = o.frame.center;
    const e = o.frame.extent;
    const v3 = (v) => (Array.isArray(v) || ArrayBuffer.isView(v) ? v.length >= 3 && [0, 1, 2].every((i) => Number.isFinite(v[i])) : v && [v.x, v.y, v.z].every(Number.isFinite));
    if (!v3(c) || !v3(e)) throw new Error("@displayxr/inline3d/splat: setRig('display') — frame must be { center: [x,y,z], extent: [x,y,z] }.");
    const a3 = (v) => (Array.isArray(v) || ArrayBuffer.isView(v) ? [v[0], v[1], v[2]] : [v.x, v.y, v.z]);
    frame = { center: a3(c), extent: a3(e) };
  }
  return {
    type,
    o: {
      vH: num('virtualDisplayHeight', (v) => v > 0),
      fit,
      margin: num('margin', (v) => v > 0),
      depthLimit: num('depthLimit', (v) => v > 0),
      fitSweep: o.fitSweep === undefined ? D.fitSweep : o.fitSweep !== false,
      idleSpin: num('idleSpin', () => true),
      ipdFactor: num('ipdFactor', (v) => v >= 0),
      parallaxFactor: num('parallaxFactor', (v) => v >= 0),
      perspectiveFactor: num('perspectiveFactor', (v) => v > 0),
      toneMapping,
      environment,
      frame,
    },
  };
}

/** setSource's transitions and their defaults. */
export const SOURCE_TRANSITIONS = Object.freeze({
  cut: {},
  crossfade: {},
  flip: { durationMs: 2200, easing: 'easeInOutSine' },
  wavefront: { durationMs: 2000, easing: 'easeInOutSine', band: 0.18, ridge: 0.03, ridgeMaxDisparity: 0.004 },
  // the particle transitions (./inline3d-splat-effects.js PARTICLE_TRANSITIONS)
  ...Object.fromEntries(Object.entries(PARTICLE_TRANSITIONS).map(([k, v]) => [k, { durationMs: v.durationMs, easing: v.easing, particle: true }])),
});

/**
 * A particle transition's two sides, resolved: { out: { effect, opts }, in: { effect, opts },
 * overlap } — the table's defaults, then the page's shared particle options, then its
 * per-side `outgoingFx` / `incomingFx` overrides. Every side is validated as its effect (throws).
 */
export function resolveParticleTransition(name, o = {}) {
  const spec = PARTICLE_TRANSITIONS[name];
  const shared = {};
  for (const k of PARTICLE_TRANSITION_OPTIONS) if (o[k] !== undefined) shared[k] = o[k];
  for (const k of ['outgoingFx', 'incomingFx']) {
    if (o[k] !== undefined && (o[k] === null || typeof o[k] !== 'object')) throw new TypeError(`@displayxr/inline3d/splat: setSource ${k} must be an object of effect options.`);
  }
  const overlap = o.overlap ?? spec.overlap ?? 0;
  if (!(typeof overlap === 'number' && overlap >= 0 && overlap <= 1)) throw new RangeError(`@displayxr/inline3d/splat: setSource overlap must be a number in [0, 1], got ${o.overlap}.`);
  const side = (which, dflt, extra) => {
    const effect = dflt.effect;
    const opts = { ...dflt.opts, ...shared, ...(extra || {}) };
    resolveEffectOptions(effect, { ...opts, scope: 'entity' }, 'set', { internal: true }); // throws on a bad one
    return { effect, opts };
  };
  const out = side('out', spec.out, o.outgoingFx);
  const inc = side('in', spec.in, o.incomingFx);
  // Both photos run ONE render-time body, compiled for one `order`; `layers` reads splat.index,
  // which is a file index only in a work-buffer modifier (not at render time).
  const order = (x) => x.opts.order ?? EFFECTS[x.effect].defaults.order;
  if (order(out) !== order(inc)) throw new Error(`@displayxr/inline3d/splat: setSource ${name}: both photos take the same order (got '${order(out)}' and '${order(inc)}').`);
  if (order(inc) === 'layers') throw new Error(`@displayxr/inline3d/splat: setSource ${name}: order 'layers' is a reveal-only order (it needs the file index, which a transition's render-time body does not have).`);
  return { out, in: inc, overlap };
}

/** Validate setSource's options into a plan (throws on a page bug, before anything loads). */
export function resolveSwap(o = {}) {
  if (o === null || typeof o !== 'object') throw new TypeError('@displayxr/inline3d/splat: setSource options must be an object.');
  const fadeMs = Number.isFinite(o.fadeMs) && o.fadeMs > 0 ? o.fadeMs : 0;
  const transition = o.transition ?? (fadeMs > 0 ? 'crossfade' : 'cut');
  if (!(transition in SOURCE_TRANSITIONS)) {
    throw new Error(`@displayxr/inline3d/splat: setSource transition '${transition}' — expected one of ${Object.keys(SOURCE_TRANSITIONS).join(', ')}.`);
  }
  const d = SOURCE_TRANSITIONS[transition];
  const durationMs = o.durationMs ?? (transition === 'crossfade' ? fadeMs || 800 : d.durationMs ?? 0);
  if (!Number.isFinite(durationMs) || durationMs < 0) throw new RangeError(`@displayxr/inline3d/splat: setSource durationMs must be ≥ 0, got ${o.durationMs}.`);
  const easing = o.easing ?? d.easing ?? 'linear';
  if (typeof easing !== 'function' && !EASINGS[easing]) throw new Error(`@displayxr/inline3d/splat: unknown easing '${easing}'.`);
  const reveal = resolveRevealOption(o.reveal);
  if (reveal && (transition === 'flip' || transition === 'wavefront' || d.particle)) {
    throw new Error(`@displayxr/inline3d/splat: setSource reveal plays with transition 'cut' or 'crossfade'; '${transition}' is its own reveal.`);
  }
  const particles = d.particle ? resolveParticleTransition(transition, o) : null;
  const band = o.band ?? d.band ?? 0.18;
  const ridge = o.ridge ?? d.ridge ?? 0.03;
  const ridgeMaxDisparity = o.ridgeMaxDisparity ?? d.ridgeMaxDisparity ?? 0.004;
  if (transition === 'wavefront') {
    EFFECTS.wavefront.validate({ band, ridge, ridgeMaxDisparity });
  }
  const outgoing = resolveOutgoingOption(o.outgoing);
  return { transition, durationMs: transition === 'crossfade' && durationMs === 0 ? 800 : durationMs, easing, reveal, band, ridge, ridgeMaxDisparity, outgoing, particles };
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
    antialias = false,
  } = opts;
  // `sortIntervalMs` is accepted and has no effect here: the engine re-sorts when the camera
  // ROTATES (one directional sort serves every view), not on a timer — docs/playcanvas-adapter.md.

  // controls:'page' — validated again here (./splat already did, at call time) because a test or
  // an advanced caller may reach this function directly.
  const ctl = resolveControls(opts);
  const pageMode = ctl.page;
  if (pageMode && ctl.ignored.length) {
    console.info(
      `[inline3d/splat] controls:'page' — the page owns the camera, so ${ctl.ignored.join(', ')} ` +
        `${ctl.ignored.length === 1 ? 'is' : 'are'} ignored.`,
    );
  }
  // The rig question is answered by the page: its camera IS the rig.
  const rigOpts = pageMode ? { ...opts, rig: 'camera' } : opts;

  const perfResolved = playcanvasPerfSettings(perf);
  const viewer = new PlayCanvasSplatViewer(canvas, {
    pageCamera: pageMode,
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
    zoom: opts.zoom,
    feather,
    captureFit,
    nearClip: opts.nearClip,
    farClip: opts.farClip,
    sky: opts.sky,
  });

  let handle = null;
  let unbindFocusInput = null;
  let removed = false;
  /** prepareSource: prepared handle → { loaded, state: 'ready' | 'used' | 'disposed', dispose }. */
  const preparedAssets = new WeakMap();
  const livePrepared = new Set();
  /** The asset on screen: its resource, kind, the pick data it keeps. */
  let current = null; // { asset, entity, res, kind, streamedBounds, alpha8, pickCentres }
  // handle.setVideo (below). Declared up here: a remove() queued before load runs during attach.
  let vid = null;
  let videoSeq = 0;
  /** The pending setVideo's canceller (a newer call, setVideo(null) or remove() supersedes it). */
  let cancelPendingVideo = null;
  let warnedAutoplayMuted = false;

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
    /**
     * controls:'page' — the page's camera for the next frame drawn. See normalizeCameraPose for
     * the arguments; last call wins; a page that stops calling keeps its last pose.
     */
    setCameraPose(matrixWorld, o) {
      if (!pageMode) {
        throw new Error(
          "@displayxr/inline3d/splat: setCameraPose() needs addSplat(…, { controls:'page' }) — " +
            'with the default controls the SDK owns the camera (use setPose).',
        );
      }
      const pose = normalizeCameraPose(matrixWorld, o);
      if (!warnedNonUniform && !pageRigTRS(pose.matrixWorld, flipY).uniform) {
        warnedNonUniform = true;
        console.warn(
          "[inline3d/splat] controls:'page' — matrixWorld has a NON-uniform scale; the adapter uses " +
            'its geometric mean. A camera pose is rotation + translation + at most a uniform scale.',
        );
      }
      lastPagePose = pose;
      viewer.setPageCamera(pose);
      return out;
    },
    /** The last pose the page set (a copy), or null before the first setCameraPose. */
    getCameraPose() {
      if (!lastPagePose) return null;
      return {
        matrixWorld: Float32Array.from(lastPagePose.matrixWorld),
        verticalFovDeg: lastPagePose.verticalFovDeg,
        near: lastPagePose.near,
        far: lastPagePose.far,
        convergence: lastPagePose.convergence,
      };
    },
    getFocus: (o) => {
      if (pageMode) return pageFocusPoint();
      // In MODEL space, like setFocus takes it.
      const f = viewer.getFocus(o);
      return contentToModel([f.x, f.y, f.z]);
    },
    setFocus(point, o = {}) {
      if (!out.mesh || !out.rig) return out;
      if (pageMode) return pageSetFocus(point, o);
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
    prepareSource,
    setRig,
    setVideo,
    /**
     * Play a transition effect (inflate, deflate, sweep, dissolve, fade, pulse, custom) — see
     * docs/splat-effects.md. Validated now; runs once the first asset is on screen. Resolves
     * { finished } (false when stopped or replaced).
     */
    playEffect(name, o = {}) {
      validateEffectCall(name, o, 'play');
      return first.then(() => (fx && !removed ? fx.play(name, o) : { finished: false }));
    },
    /** Set a persistent effect (grade, clip, custom), hold a transition at `progress`, or null to remove. */
    setEffect(name, params) {
      validateEffectCall(name, params, 'set');
      if (fx) fx.set(name, params);
      else fxPending.push(['set', name, params]);
      return out;
    },
    /** Stop one effect (or all): `finish: true` jumps to its end state, else removes it. */
    stopEffect(name, o = {}) {
      if (fx) fx.stop(name, o);
      else fxPending.push(['stop', name, o]);
      return out;
    },
    /** What is on: [{ name, scope, stage, playing, waiting, progress }]. */
    effects: () => (fx ? fx.list() : []),
    remove() {
      removed = true;
      dropVideo(); // before the app goes: the plane's rVFC, and a <video> this handle made
      current = null;
      for (const p of [...livePrepared]) p.dispose();
      fx?.dispose();
      fx = null;
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

  // ── splat effects (./inline3d-splat-effects.js) ──
  let fx = null;
  const fxPending = []; // setEffect / stopEffect before the first asset landed
  const revealSpec = resolveRevealOption(opts.reveal); // throws on a bad one (./splat did too)
  /** A promise resolved after `n` more viewer ticks: the first draw of a new asset builds its
   * work buffer (hundreds of ms on a big file) and must not eat an effect's clock. */
  const afterTicks = (n) =>
    new Promise((resolve) => {
      let k = 0;
      viewer._hooks.push(() => {
        if (++k < n) return true;
        resolve();
        return false;
      });
    });
  function makeEffects(pc) {
    const ctx = {
      pc: () => pc,
      app: () => viewer.app,
      now: () => now(),
      eyes: () => viewer.eyeFrame(),
      focus: () => {
        if (pageMode) {
          const f = pageFocusPoint();
          return f ? modelToContent(f) : viewer.eyeFrame().origin;
        }
        const f = viewer.getFocus();
        return [f.x, f.y, f.z];
      },
      framing: () => out.frame,
      pick: (x, y) => {
        const m = pickModel(x, y);
        return m ? modelToContent(m) : null;
      },
      modelToContent,
      entity: () => current?.entity ?? null,
    };
    const f = new SplatEffects(ctx);
    viewer.onEffectsTick = (t) => {
      if (!f.active) return;
      f.tick(t);
      f.flush();
    };
    return f;
  }

  // ── controls:'page' state (null/unused on the viewer's own controls) ──
  let lastPagePose = null; // what the page last handed setCameraPose, validated
  let warnedNonUniform = false;
  // The convergence the adapter owns when the page gives none, in MODEL units (so it is stable
  // while the camera moves): the waterfall's on load / setSource, a setFocus after that. Eased
  // toward `target` at the viewer's FOCUS_EASE unless snapped.
  const pageFocus = { d: Number.NaN, target: Number.NaN, fired: Number.NaN, source: null };

  if (wall && wall.supported) {
    handle = wall.addScene(canvas, viewer.onFrame, {
      // controls:'page' starts on a camera rig (attach, provisional FOV/convergence until the page
      // and the waterfall say otherwise); the display rig's height means nothing there.
      ...(pageMode
        ? { viewRig: pageViewRig({ verticalFovDeg: viewer.page.fov, convergence: 2, comfortDepth: ctl.comfortDepth }) }
        : { virtualDisplayHeight }),
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

  // ── controls:'page': focus = the convergence point on the page camera's view axis ──
  /** The convergence distance for THIS frame, in page units, and where it came from. */
  function pageConvergence() {
    const ax = pageViewAxis(viewer.page.matrix);
    if (lastPagePose && lastPagePose.convergence !== null) {
      return { d: lastPagePose.convergence, ax, source: 'page' };
    }
    const dm = Number.isFinite(pageFocus.d) ? pageFocus.d : 2;
    return { d: dm / (ax.scale || 1), ax, source: out.rig?.focusSource ?? 'default' };
  }
  function pageFocusPoint() {
    if (!out.rig) return null;
    const { d, ax } = pageConvergence();
    const dm = d * ax.scale;
    return [ax.origin[0] + ax.forward[0] * dm, ax.origin[1] + ax.forward[1] * dm, ax.origin[2] + ax.forward[2] * dm];
  }
  function pageSetFocus(point, { snap = false } = {}) {
    let dm;
    if (point == null) {
      dm = out.rig.convergenceDefault;
      out.rig.focus = out.rig.focusDefault;
      out.rig.focusSource = out.rig.focusDefaultSource;
    } else {
      const m = toArray3(point);
      const ax = pageViewAxis(viewer.page.matrix);
      dm = (m[0] - ax.origin[0]) * ax.forward[0] + (m[1] - ax.origin[1]) * ax.forward[1] + (m[2] - ax.origin[2]) * ax.forward[2];
      if (!(dm > 0)) {
        console.warn('[inline3d/splat] setFocus: that point is behind the page camera — focus unchanged');
        return out;
      }
      out.rig.focus = m;
      out.rig.focusSource = 'set';
    }
    pageFocus.target = dm;
    if (snap || !Number.isFinite(pageFocus.d)) pageFocus.d = dm;
    return out;
  }
  /** Per tick (before the draw, so the rig drives the next locate): ease, declare, notify. */
  function pageTick() {
    if (Number.isFinite(pageFocus.target) && pageFocus.d !== pageFocus.target) {
      const dd = pageFocus.target - pageFocus.d;
      pageFocus.d = Math.abs(dd) < 1e-6 ? pageFocus.target : pageFocus.d + dd * FOCUS_EASE;
    }
    const { d, source } = pageConvergence();
    out.viewRig = pageViewRig(
      {
        verticalFovDeg: viewer.page.fov,
        convergence: d,
        comfortDepth: ctl.comfortDepth,
        ipdFactor: out.rig ? out.rig.ipdFactor : Number.isFinite(opts.ipdFactor) ? opts.ipdFactor : 1,
        parallaxFactor: out.rig ? out.rig.parallaxFactor : Number.isFinite(opts.parallaxFactor) ? opts.parallaxFactor : 1,
      },
      out.viewRig || {},
    );
    handle?.setViewRig?.(out.viewRig);
    if (!out.rig) return;
    out.rig.convergence = d;
    if (Math.abs(d - pageFocus.fired) > 1e-3 || source !== pageFocus.source) {
      pageFocus.fired = d;
      pageFocus.source = source;
      const cb = out.onFocusChange;
      if (typeof cb === 'function') cb(pageFocusPoint(), { focusSource: source });
    }
  }
  if (pageMode) viewer.onTick = pageTick;

  // onBeforeFrame: the page's game step INSIDE this adapter's frame, before the tick and the
  // draw — so a setCameraPose made in it is what this frame renders (zero lag, the attach
  // pattern). The session rAF (3D) and the window rAF have no guaranteed order, so a pose set
  // from the page's own rAF may be one frame late. A throw is the page's bug: warned once, and
  // the frame still renders (with whatever pose it had).
  if (pageMode && typeof opts.onBeforeFrame === 'function') {
    const cb = opts.onBeforeFrame;
    let lastT = 0;
    let warned = false;
    viewer._beforeFrame = (views) => {
      const t = now();
      const dt = lastT ? Math.min((t - lastT) / 1000, MAX_DT_S) : 0;
      lastT = t;
      try {
        cb({ time: t, views, dt });
      } catch (err) {
        if (!warned) {
          warned = true;
          console.warn('[inline3d/splat] onBeforeFrame threw (warned once; frames keep rendering)', err);
        }
      }
    };
  }

  // ── focus → view rig ──
  let lastConvergence = Number.NaN;
  // The camera rig's descriptor object (rewritten in place per focus change) and the DISPLAY rig
  // declared through setViewRig, if any. `declaredDisplay` null + no camera rig pushed = the
  // `virtualDisplayHeight` shorthand addScene was built with, which is where every non-page tile
  // starts. A display rig after a camera rig has to be SENT (the shorthand cannot be restored),
  // as the explicit descriptor it is shorthand for (displayRig: identity pose, factors 1).
  let camRigObj = null;
  let declaredDisplay = pageMode ? 'page' : 'shorthand';
  function pushViewRig(force) {
    if (pageMode) return; // pageTick declares the rig every frame
    if (vid?.on) return; // setVideo holds the display rig; exit re-declares what was there
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
    camRigObj ||= {};
    declaredDisplay = null;
    out.viewRig = camRigObj = cameraRigFromPose(
      {
        position: { x: pose[12], y: pose[13], z: pose[14] },
        orientation: { x: q[0], y: q[1], z: q[2], w: q[3] },
        fov: viewer.mono.fov,
      },
      {
        convergence: d > 0 ? d : 0,
        ipdFactor: out.rig.ipdFactor,
        parallaxFactor: out.rig.parallaxFactor,
        out: camRigObj,
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
    const toContent = mat4Mul(viewer.rigMatrix(), v.pose);
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
    // controls:'page' binds no input at all: gestures are the page's (pick + setFocus remain).
    if (pageMode || focusInput === false || unbindFocusInput) return;
    unbindFocusInput = bindFocusGestures(canvas, {
      onDoubleClick: (e) => {
        if (vid?.on) return false; // a video plane: nothing to focus on
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
  async function loadOne(pc, app, source, { background = false } = {}) {
    // prepareSource: our own passes run in idle periods; setSource: at the task's own priority.
    const y = background ? yieldIdle : yieldToMain;
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
    if (bytes && rigOpts.rig !== 'display') camera = sogCameraFromMeta(await readSogMeta(bytes));
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
    if (!bytes && rigOpts.rig !== 'display') camera = sogCameraFromMeta(desc.meta);
    const cloud = desc.kind === 'flat' ? await readCloud(res, y) : null;
    // The cloud passes, each in its OWN task: framing, the rest-space sample and the pick set
    // were one ~60 ms main-thread block on a 1.18M-gaussian swap — pointer input waited on it.
    // Split with a yield between them (and a linear-time percentile in boundsFromPositions),
    // no single step is a long task any more. Same numbers, same order.
    const pre = { local: null, rest: null, pickCentres: null };
    if (cloud) {
      const walk = centresVisitor(cloud.xyz, cloud.opacity, cloud.total);
      await y();
      let t = performance.now();
      const framed = sampleCloudCentres(cloud.total, walk) || [];
      perfSpan('cloud:frame-sample', t);
      await y();
      // The percentile core per axis + the window pass, each in its own task (bit-identical to
      // boundsFromPositions): one ~60-80 ms task per 1.18M gaussians at 4× CPU before.
      t = performance.now();
      pre.local = await boundsFromPositionsAsync(framed, undefined, y);
      perfSpan('cloud:bounds', t);
      await y();
      t = performance.now();
      if (rigNeedsCloud(camera)) pre.rest = sampleCloudRestSpace(cloud.total, walk, camera?.rest);
      perfSpan('cloud:rest-sample', t);
      await y();
      t = performance.now();
      const s = sampleCloudCentres(cloud.total, walk, { cap: RIG_SAMPLE_CAP });
      pre.pickCentres = s ? s.slice() : null;
      perfSpan('cloud:pick-set', t);
      await y();
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

    // What the waterfall was fed, kept with the asset: handle.setRig re-resolves from exactly this
    // (never from a stale copy of the result), so setRig('camera') / ('auto') land where a load did.
    const rigIn = { camera: loaded.camera, sample: loaded.pre?.rest || null, bounds };
    // A setRig choice is STICKY across setSource: the new asset is resolved on the chosen rig.
    const resolved = resolveFor(rigIn, rigOverride ? rigOverride.type : 'auto');
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

    if (pageMode) {
      // The page owns the pose; the waterfall only supplies the convergence (re-estimated here,
      // on load and on setSource, never per frame). Until the page's first setCameraPose the
      // camera sits at the asset's rest pose (the block's, else the origin looking down +z) with
      // the resolved lens, so the first frame is not an empty tile.
      resolved.convergenceDefault = resolved.convergence;
      pageFocus.target = pageFocus.d = resolved.convergence;
      pageFocus.fired = Number.NaN;
      if (!lastPagePose) {
        const r = resolved.rest;
        viewer.setPageCamera(
          normalizeCameraPose(poseMatrix(r.position, qmul(r.rotation, FLIP_Q)), {
            verticalFovDeg: captureVerticalFovDeg(resolved.intrinsics, NaN, MONO_NEAR, 'height'),
          }),
        );
      }
    } else {
      applyRig(resolved, bounds, false);
    }
    return { pickCentres, alpha8: cloud?.alpha8 || null, rigIn };
  }

  /** resolveRig on an asset's kept inputs: 'auto' = the load-time waterfall, else forced. */
  function resolveFor(rigIn, type) {
    const box = canvas.getBoundingClientRect();
    const resolved = resolveRig({
      camera: rigIn.camera,
      opts: type === 'auto' ? rigOpts : { ...rigOpts, rig: type },
      cloud: rigIn.sample,
      canvasAspect: box.height > 0 ? box.width / box.height : 4 / 3,
    });
    if (type !== 'auto') resolved.typeSource = 'setRig';
    resolved.focusDefault = resolved.focus.slice();
    resolved.focusDefaultSource = resolved.focusSource;
    return resolved;
  }

  /** The framing knobs the viewer's fit reads, as addSplat was booted with. */
  const bootFraming = { vH: virtualDisplayHeight, fit, margin, depthLimit, fitSweep };
  function setFraming(f) {
    viewer.vH = f.vH;
    viewer.fit = f.fit;
    viewer.margin = f.margin;
    viewer.depthLimit = f.depthLimit;
    viewer.fitSweep = f.fitSweep;
  }

  /** Declare a DISPLAY rig to the runtime, unless that exact one is already declared. */
  function declareDisplay(f) {
    const key = `${f.vH}|${f.ipdFactor ?? 1}|${f.parallaxFactor ?? 1}|${f.perspectiveFactor ?? 1}`;
    if (declaredDisplay === key) return;
    // Back at the boot rig from the shorthand it was built with: nothing to say.
    if (declaredDisplay === 'shorthand' && key === `${bootFraming.vH}|1|1|1`) return;
    declaredDisplay = key;
    lastConvergence = Number.NaN;
    out.viewRig = displayRig({
      virtualDisplayHeight: f.vH,
      ipdFactor: f.ipdFactor ?? 1,
      parallaxFactor: f.parallaxFactor ?? 1,
      perspectiveFactor: f.perspectiveFactor ?? 1,
    });
    handle?.setViewRig?.(out.viewRig);
  }

  /**
   * Put the viewer on a resolved rig: lens, framing, focus, and the rig declared to the runtime.
   * Shared by every load / setSource (reset=false: the pose is kept) and handle.setRig
   * (reset=true: the pose goes back to the rig's rest, yaw = pitch = 0, zoom 1, depth 0).
   */
  function applyRig(resolved, bounds, reset) {
    const disp = rigOverride?.type === 'display' ? rigOverride.o : null;
    if (reset) viewer.resetPose();
    if (resolved.type === 'camera') {
      setFraming(bootFraming);
      if (!('idleSpin' in opts)) viewer.idleSpin = 0;
      else if (reset) viewer.idleSpin = idleSpin;
      // The camera rig never auto-fits (the capture IS the framing): a scale left by a previous
      // display-rig asset (setSource) must not shrink this one.
      viewer.resetFit();
      viewer.useCaptureCamera(resolved);
      viewer.setFocus(modelToContent(resolved.focus), { snap: true, recentre: false });
      lastConvergence = Number.NaN;
      pushViewRig(true);
      return;
    }
    if (viewer.mono.capture) viewer.useDisplayCamera();
    // The display rig orbits the frame centre (SceneViewer's recentre), whatever a camera rig
    // before it left in the viewer.
    viewer._focusRecentres = true;
    const target = disp ? displayTarget(disp) : null;
    if (target) {
      // setRig('display') framing the page's content: addModel's fit, on addModel's defaults.
      setFraming(disp);
      viewer.idleSpin = disp.idleSpin;
      viewer.fitTo(target.center, target.extent);
      resolved.focus = contentToModel(target.center);
      resolved.focusSource = 'frame';
      resolved.focusDefault = resolved.focus.slice();
      resolved.focusDefaultSource = 'frame';
      resolved.frame = target;
      declareDisplay(disp);
      return;
    }
    // The splat itself, as a display-rig addSplat frames it (the load-time path).
    setFraming(disp || bootFraming);
    if (reset) viewer.idleSpin = disp ? disp.idleSpin : idleSpin;
    if (bounds) viewer.fitTo(bounds.center, bounds.extent);
    else console.warn('[inline3d/splat] no usable bounds — subject is UNFRAMED (model scale)', src);
    if (resolved.focusSource === 'caller' || resolved.focusSource === 'block') {
      viewer.setFocus(modelToContent(resolved.focus), { snap: true, recentre: true });
    }
    if (disp) resolved.frame = bounds ? { center: bounds.center.slice(), extent: bounds.extent.slice(), source: 'splat' } : null;
    declareDisplay(disp || { vH: bootFraming.vH });
  }

  // ── handle.setRig: a live, reversible rig switch (docs/playcanvas-adapter.md §setRig) ──
  /** null = 'auto' (the per-asset waterfall); else { type: 'camera' } | { type: 'display', o }. */
  let rigOverride = null;
  let rigSeq = 0;
  /** The IBL setRig('display') installed ({ kind, atlas, prev }), and what it replaced — or null. */
  let rigEnv = null;
  /** ./inline3d-model-playcanvas.js once a display rig has loaded it (transmission, environments). */
  let rigModelModule = null;
  /** Mesh instances / materials prepareTransmission has handled, and whether it turned the grab on. */
  const rigTransmissionSeen = new WeakSet();
  let rigGrab = false;
  let rigTick = 0;
  const baseToneMapping = viewer.toneMapping;

  /** Is the splat on screen: its entity (and every ancestor) enabled. */
  function splatShown() {
    let e = current?.entity || null;
    if (!e) return false;
    for (; e; e = e.parent) if (e.enabled === false) return false;
    return true;
  }

  /**
   * World AABB of the page's meshes under handle.engine.root — enabled render components only,
   * union of their mesh instances' `aabb` (the engine's world box, skinning included). Content
   * space. The same measurement addModel's boundsOfEntity takes of its glTF.
   */
  function rootMeshBounds() {
    const root = viewer.content;
    const renders = root?.findComponents ? root.findComponents('render') : [];
    let min = null;
    let max = null;
    for (const r of renders) {
      if (r.enabled === false || r.entity?.enabled === false) continue;
      for (const mi of r.meshInstances || []) {
        const b = mi.aabb;
        if (!b) continue;
        const c = b.center;
        const h = b.halfExtents;
        const lo = [c.x - h.x, c.y - h.y, c.z - h.z];
        const hi = [c.x + h.x, c.y + h.y, c.z + h.z];
        if (!lo.every(Number.isFinite) || !hi.every(Number.isFinite)) continue;
        if (!min) {
          min = lo;
          max = hi;
        } else {
          for (let i = 0; i < 3; i++) {
            if (lo[i] < min[i]) min[i] = lo[i];
            if (hi[i] > max[i]) max[i] = hi[i];
          }
        }
      }
    }
    return min ? { min, max } : null;
  }

  /**
   * What setRig('display') frames: the caller's `frame`, else the meshes under root (plus the
   * splat's measured box if it is shown), else null — the splat, as a display-rig addSplat would.
   */
  function displayTarget(disp) {
    if (disp.frame) {
      return { center: toArray3(disp.frame.center), extent: toArray3(disp.frame.extent).map((v) => Math.max(Math.abs(v), 1e-6)), source: 'caller' };
    }
    const m = rootMeshBounds();
    if (!m) return null;
    let { min, max } = m;
    let source = 'root';
    const sb = splatShown() ? out.frame : null;
    if (sb) {
      source = 'root+splat';
      min = min.map((v, i) => Math.min(v, sb.center[i] - sb.extent[i] / 2));
      max = max.map((v, i) => Math.max(v, sb.center[i] + sb.extent[i] / 2));
    }
    return {
      center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
      extent: [Math.max(max[0] - min[0], 1e-6), Math.max(max[1] - min[1], 1e-6), Math.max(max[2] - min[2], 1e-6)],
      source,
    };
  }

  /** Per tick: addModel's tone mapping for the page's meshes while the splat is hidden. */
  viewer.onTick = pageMode
    ? viewer.onTick
    : () => {
        const display = rigOverride?.type === 'display';
        const want = display && !splatShown() ? rigOverride.o.toneMapping : baseToneMapping;
        if (want !== viewer.toneMapping) viewer.setToneMapping(want);
        // A transmissive glTF the page hangs under root on the display rig (a glass
        // lantern): addModel's grab pass + pass order + per-eye grab UV. Re-checked every 30
        // frames, since a page adds its meshes whenever they load — before or after setRig.
        if (display && rigModelModule && pcModule && (rigTick++ % 30 === 0)) syncRigTransmission();
      };

  /** prepareTransmission over root; the grab pass on while a transmissive mesh is there. */
  function syncRigTransmission() {
    const n = rigModelModule.prepareTransmission(pcModule, viewer.content, viewer.app?.graphicsDevice, rigTransmissionSeen);
    if ((n > 0) !== rigGrab) {
      rigGrab = n > 0;
      viewer.useSceneColor(rigGrab);
    }
  }

  /** Install addModel's IBL (`disp.environment`) for the display rig, if the page has none of its own. */
  async function ensureRigEnvironment(disp, seq) {
    const m = (rigModelModule ||= await import('./inline3d-model-playcanvas.js'));
    if (removed || seq !== rigSeq || rigOverride?.type !== 'display') return;
    rigTick = 0; // transmission check on the next tick
    const kind = disp.environment;
    if (rigEnv && rigEnv.kind === kind) return;
    dropRigEnvironment(); // a different environment of ours (setRig('display') called again)
    if (kind === 'none' || viewer.sky) return;
    const app = viewer.app;
    const scene = app?.scene;
    if (!scene || scene.envAtlas) return; // the page lights its own meshes: leave it alone
    const prev = { skyboxIntensity: scene.skyboxIntensity, exposure: scene.exposure, skyboxRotation: scene.skyboxRotation };
    const atlas = kind === 'room' ? m.useRoomEnvironment(pcModule, app, m.ROOM_YAW_DEG) : m.useNeutralStudio(pcModule, app, m.ENV_YAW_DEG);
    rigEnv = { kind, atlas, prev };
  }

  /** Undo ensureRigEnvironment (only what it installed, only if the page has not replaced it). */
  function dropRigEnvironment() {
    if (!rigEnv) return;
    const scene = viewer.app?.scene;
    const { atlas, prev } = rigEnv;
    rigEnv = null;
    if (!scene || scene.envAtlas !== atlas) return;
    scene.envAtlas = null;
    scene.skyboxIntensity = prev.skyboxIntensity;
    scene.exposure = prev.exposure;
    if (prev.skyboxRotation !== undefined) scene.skyboxRotation = prev.skyboxRotation;
    atlas.destroy?.();
  }

  /**
   * handle.setRig(type, options) — switch the rig the window is seen through, live: no remount,
   * no reload, no new session. 'display' frames the page's meshes under handle.engine.root (plus
   * the splat when shown) on addModel's defaults; 'camera' is the asset's capture rig re-resolved
   * from the waterfall's own inputs; 'auto' is exactly what the load resolved. The pose resets to
   * the new rig's rest. Sticky across setSource until setRig('auto'). Resolves to the handle once
   * applied (the display rig's default environment included).
   */
  function setRig(type, o = {}) {
    const req = validateSetRig(type, o, pageMode);
    if (vid) throw new Error(VIDEO_BUSY('setRig'));
    const seq = ++rigSeq;
    return first.then(async () => {
      if (removed || seq !== rigSeq || !current) return out;
      rigOverride = req.type === 'auto' ? null : req;
      if (req.type !== 'display') {
        dropRigEnvironment();
        if (rigGrab) {
          rigGrab = false;
          viewer.useSceneColor(false);
        }
      }
      const resolved = resolveFor(current.rigIn, req.type);
      out.rig = resolved;
      applyRig(resolved, current.rigIn.bounds, true);
      viewer.onTick?.(); // tone mapping now, not a frame late
      if (req.type === 'display') await ensureRigEnvironment(req.o, seq);
      return out;
    });
  }

  let pcModule = null;
  const booted = (async () => {
    // Named re-exports, not the package namespace: lets a bundler drop the ~40% of the engine the
    // SDK never touches (./inline3d-playcanvas-engine.js).
    const pc = opts.playcanvas || (await import('./inline3d-playcanvas-engine.js'));
    if (removed) return null;
    const app = await viewer.attachEngine(pc, {
      preserveDrawingBuffer,
      perf: perfResolved,
      viewPath: opts.playcanvasViewPath,
      antialias: antialias === true,
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
    fx = makeEffects(pcModule);
    // `reveal`: installed at its START state before the asset's first frame, played once the
    // tile is woven (handle.firstWoven — which is immediate in 2D) and the first frames are built.
    if (revealSpec) {
      const gate = Promise.resolve(out.firstWoven).then(() => afterTicks(2));
      fx.play(revealSpec.type, revealSpec.raw, { gate });
    }
    for (const [what, name, arg] of fxPending.splice(0)) {
      if (what === 'set') fx.set(name, arg);
      else fx.stop(name, arg);
    }
    bindFocusInput();
    return out;
  });

  // ── handle.setVideo: a stereo video on this handle (docs/playcanvas-adapter.md §setVideo) ──
  /**
   * The video state: null = no video. `on` once the plane is up (the splat hidden, the display rig
   * declared); `saved` is everything the entry changed, restored exactly by setVideo(null).
   */
  // (state: `vid`, `videoSeq`, `cancelPendingVideo` — declared with `current`, above: remove() reads them)

  /** The <video> for a URL: made here, owned (and released) by this handle. */
  function makeVideoElement(url) {
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous'; // WebGL refuses a tainted frame; same-origin is unaffected
    v.playsInline = true;
    v.preload = 'auto';
    v.src = url;
    return v;
  }
  /** Let go of a <video> this handle made: stop it and free its decoder. */
  function releaseOwned(v) {
    try {
      v.pause();
      v.removeAttribute('src');
      v.load();
    } catch {
      /* already gone */
    }
  }
  /** Resolves once `v` has a current frame (readyState ≥ 2); rejects on error or cancel. */
  function waitForFrame(v, seq) {
    return new Promise((resolve, reject) => {
      const off = () => {
        v.removeEventListener('loadeddata', ok);
        v.removeEventListener('error', bad);
        if (cancelPendingVideo === cancel) cancelPendingVideo = null;
      };
      const ok = () => (off(), resolve());
      const bad = () => {
        off();
        const e = v.error;
        reject(new Error(`@displayxr/inline3d/splat: setVideo — the video failed to load${e ? ` (${e.message || `code ${e.code}`})` : ''}.`));
      };
      const cancel = () => {
        off();
        const err = new Error('@displayxr/inline3d/splat: setVideo — superseded by a later setVideo / remove() before its first frame.');
        err.name = 'AbortError';
        reject(err);
      };
      cancelPendingVideo = cancel;
      if (seq !== videoSeq) return cancel();
      if ((v.readyState || 0) >= 2 && v.videoWidth > 0) return ok();
      v.addEventListener('loadeddata', ok);
      v.addEventListener('error', bad);
    });
  }
  function autoplay(v) {
    const p = v.play?.();
    if (!p || typeof p.catch !== 'function') return;
    p.catch((err) => {
      // No user gesture yet: the browser allows a MUTED play. The page unmutes on its next gesture.
      if (err?.name !== 'NotAllowedError' || v.muted) return;
      v.muted = true;
      if (!warnedAutoplayMuted) {
        warnedAutoplayMuted = true;
        console.info('[inline3d/splat] setVideo: autoplay with sound was refused (no user gesture yet) — playing MUTED; set video.muted = false on a gesture.');
      }
      v.play().catch(() => {});
    });
  }

  /** Everything the entry changes, for an exact restore. */
  function snapshotForVideo() {
    const v = viewer;
    const entity = current?.entity || null;
    return {
      entity,
      splatEnabled: entity ? entity.enabled : null,
      vH: v.vH,
      idleSpin: v.idleSpin,
      mono: { fov: v.mono.fov, near: v.mono.near, far: v.mono.far, pose: Float64Array.from(v.mono.pose), capture: v.mono.capture },
      pose: {
        _yaw: v._yaw, _pitch: v._pitch, _targetYaw: v._targetYaw, _targetPitch: v._targetPitch,
        _zoom: v._zoom, _targetZoom: v._targetZoom, _depthOffset: v._depthOffset,
        _focusSettled: v._focusSettled, _focusRecentres: v._focusRecentres, _orbitMode: v._orbitMode, _lastInput: v._lastInput,
      },
      focus: { ...v._focus },
      targetFocus: { ...v._targetFocus },
      viewRig: out.viewRig,
      declaredDisplay,
      lastConvergence,
    };
  }

  /** Enter: the splat hidden, the display camera + rig, the plane up. One task: one frame sees it all. */
  function enterVideo(state) {
    const v = viewer;
    state.saved = snapshotForVideo();
    if (state.saved.entity) state.saved.entity.enabled = false;
    v.inputLocked = true;
    v.idleSpin = 0;
    v.vH = state.vH;
    if (v.mono.capture) v.useDisplayCamera(); // camera rig → the display rig's mono camera
    else {
      v._placeMonoForFit();
      v._updateMonoProjection();
    }
    declareDisplay({ vH: state.vH });
    state.on = true;
  }

  /** Exit: put back exactly what enterVideo changed, and the declaration that was there. */
  function exitVideo(state) {
    const v = viewer;
    const s = state.saved;
    v._videoPlane?.destroy();
    v._videoPlane = null;
    if (s.entity) s.entity.enabled = s.splatEnabled;
    v.vH = s.vH;
    v.idleSpin = s.idleSpin;
    Object.assign(v.mono, { fov: s.mono.fov, near: s.mono.near, far: s.mono.far, pose: s.mono.pose, capture: s.mono.capture });
    Object.assign(v, s.pose);
    v._focus = { ...s.focus };
    v._targetFocus = { ...s.targetFocus };
    v._updateMonoProjection(); // recomputed, not copied: the box may have been resized meanwhile
    v._applyTransform();
    v.inputLocked = false;
    lastConvergence = s.lastConvergence;
    if (declaredDisplay !== s.declaredDisplay) {
      if (s.declaredDisplay === 'shorthand') {
        // The boot shorthand cannot be restored: its explicit form (what it is shorthand for).
        declaredDisplay = null;
        declareDisplay({ vH: bootFraming.vH });
      } else {
        declaredDisplay = s.declaredDisplay;
        out.viewRig = s.viewRig;
        handle?.setViewRig?.(out.viewRig);
      }
    } else out.viewRig = s.viewRig;
    lastConvergence = s.lastConvergence;
    state.on = false;
  }

  /** Tear the video down now (setVideo(null) / remove()). */
  function dropVideo() {
    videoSeq++;
    cancelPendingVideo?.();
    const state = vid;
    vid = null;
    if (!state) return;
    if (state.on) exitVideo(state);
    if (state.owned) releaseOwned(state.el);
  }

  /**
   * handle.setVideo(src, options) — play a stereo video on THIS handle: no new canvas, layer or
   * session. The splat is hidden and a screen-locked plane on the display rig shows the video, each
   * eye its own half (sbs: left/right, tb: top/bottom); flat (mono), the left half at full
   * resolution. Applies on the first frame the video has. Resolves to `{ video, remove(), stats() }`;
   * the page drives transport through `video`. setVideo(null) exits and restores the splat, the rig
   * and its declaration exactly as they were. Throws during an in-flight setSource.
   */
  function setVideo(src, o = {}) {
    if (src === null || src === undefined) {
      if (pageMode) throw new Error(PAGE_VIDEO_ERROR);
      dropVideo();
      return Promise.resolve(null);
    }
    const r = validateSetVideo(src, o, pageMode);
    if (sourceInFlight > 0) {
      throw new Error(
        '@displayxr/inline3d/splat: setVideo() during an in-flight setSource() — await the swap first ' +
          '(a video and a transition cannot share the tile).',
      );
    }
    const seq = ++videoSeq;
    cancelPendingVideo?.();
    const prev = vid;
    const owned = typeof r.src === 'string';
    const el = owned ? makeVideoElement(r.src) : r.src;
    if (r.loop !== undefined) el.loop = r.loop;
    if (r.muted !== undefined) el.muted = r.muted;
    if (owned ? r.autoplay !== false : r.autoplay === true) autoplay(el);
    // The guard state is taken NOW (setSource / setRig refuse from this call on), the pixels change
    // on the first frame the video has.
    const state = { seq, el, owned, format: r.format, fit: r.fit, vH: r.vH ?? bootFraming.vH, on: false, saved: null, pending: true };
    if (!prev || !prev.on) vid = state; // a pending one it supersedes is cancelled above
    return first
      .catch(() => null)
      .then(() => waitForFrame(el, seq))
      .then(() => {
        if (removed || seq !== videoSeq || !viewer.app) throw Object.assign(new Error('@displayxr/inline3d/splat: setVideo — superseded.'), { name: 'AbortError' });
        const live = vid && vid.on ? vid : null;
        if (live) {
          // Another video on screen: keep ITS snapshot (the pre-video state), swap the source.
          state.saved = live.saved;
          state.on = true;
          if (live.owned && live.el !== el) releaseOwned(live.el);
          if (state.vH !== live.vH) {
            viewer.vH = state.vH;
            viewer._placeMonoForFit();
            viewer._updateMonoProjection();
            declareDisplay({ vH: state.vH });
          }
        } else enterVideo(state);
        vid = state;
        state.pending = false;
        viewer._videoPlane ||= new VideoPlane(viewer);
        viewer._videoPlane.setSource(el, { format: state.format, fit: state.fit, vH: state.vH });
        const plane = viewer._videoPlane;
        return Object.freeze({
          video: el,
          format: state.format,
          fit: state.fit,
          /** Exit (setVideo(null)) — a no-op once another setVideo replaced this one. */
          remove: () => (vid === state ? setVideo(null) : Promise.resolve(null)),
          /** Upload accounting: frames drawn with the plane up, and texture uploads (new frames). */
          stats: () => ({ frames: plane.frames, uploads: plane.uploads }),
        });
      })
      .catch((err) => {
        // Failed or superseded before it showed: nothing changed on screen; free what we made.
        if (vid === state) vid = null;
        if (owned && (!vid || vid.el !== el)) releaseOwned(el);
        throw err;
      });
  }

  // ── prepareSource: load the next asset in the background, for a setSource with no load ──
  /**
   * Fetch, decode and upload `src` now, without rendering it: the engine's load (its own unpack
   * runs when it must) and our cloud passes (framing, rig sample, pick set — in IDLE periods).
   * Resolves to an opaque handle for setSource(prepared, opts), which then starts on the next
   * frame with no load on the transition frame. `dispose()` if the page changes its mind.
   * Memory: the prepared asset is fully resident (a 1.18M-gaussian SOG: its GPU textures plus the
   * engine's centre array) alongside the current one until it is used or disposed.
   */
  async function prepareSource(src, po = {}) {
    if (po === null || typeof po !== 'object') throw new TypeError('@displayxr/inline3d/splat: prepareSource options must be an object.');
    const warm = po.transition !== undefined ? resolveSwap(po) : null; // the setSource options it will get; throws on a bad one
    const app = await booted;
    await first.catch(() => null);
    if (!app || removed) throw new Error('@displayxr/inline3d/splat: prepareSource on a removed tile.');
    const t0 = performance.now();
    const loaded = await loadOne(pcModule, app, src, { background: true });
    perfSpan('prepareSource', t0);
    // The transition the page declared: compile its shader now, in the dwell, not on its first frame.
    if (warm?.particles) await prewarmTransition(warm);
    const entry = { loaded, state: 'ready', dispose: null };
    const prepared = {
      [PREPARED_TAG]: true,
      /** The asset's own count (every splat of a flat source). */
      numSplats: loaded.desc.numSplats || loaded.cloud?.sourceTotal || 0,
      /** 'ready' until setSource uses it ('used') or dispose() drops it ('disposed'). */
      get state() {
        return entry.state;
      },
      dispose() {
        if (entry.state !== 'ready') return;
        entry.state = 'disposed';
        livePrepared.delete(entry);
        app.assets.remove(loaded.asset);
        loaded.asset.unload?.();
      },
    };
    entry.dispose = prepared.dispose;
    preparedAssets.set(prepared, entry);
    if (removed) {
      prepared.dispose();
      throw new Error('@displayxr/inline3d/splat: prepareSource on a removed tile.');
    }
    livePrepared.add(entry);
    return prepared;
  }

  // ── shader pre-warm for the particle transitions ──
  const prewarmed = new Set();
  /**
   * Compile + link the render-time variant a particle transition will install, ahead of it. The
   * first frame of a transition otherwise blocks on the link (GetProgramiv: 35–45 ms on an M1,
   * measured with a trace) — on the very transition a user sees first. A throwaway material with
   * the eye renderer's own description, defines and chunks, plus the transition's chunk, asks the
   * engine's program library for the same variant the renderer will ask for (the library keys on
   * the generated source + processing options, not on the material), so the compile is issued
   * now and, with KHR_parallel_shader_compile, finishes off the main thread. Best effort: an
   * engine whose internals differ just compiles on the transition's first frame, as before.
   */
  async function prewarmTransition(plan) {
    const key = `${plan.particles.in.effect}|${plan.particles.in.opts.order ?? ''}`;
    if (!fx || prewarmed.has(key)) return;
    await yieldIdle();
    if (removed || !fx) return;
    try {
      const pc = pcModule;
      const cams = [viewer.eye, viewer._live?.cam].filter(Boolean);
      const code = fx.sharedChunkCode('transition', plan.particles.in.effect, { order: plan.particles.in.opts.order });
      const made = [];
      let issued = 0;
      for (const cam of cams) {
        const cd = viewer.app?.renderer?.gsplatDirector?.camerasMap?.get?.(cam.camera?.camera);
        let mi = null;
        if (cd?.layersMap) for (const ld of cd.layersMap.values()) mi ||= ld?.gsplatManager?.renderer?.meshInstance ?? null;
        const src = mi?.material;
        const camera = cam.camera?.camera;
        if (!src?.shaderDesc || !camera?.shaderParams || typeof src.getShaderVariant !== 'function') continue;
        const m = new pc.ShaderMaterial(src.shaderDesc);
        src.defines.forEach((v, k) => m.setDefine(k, v));
        m.shaderChunks.copy(src.shaderChunks);
        m.getShaderChunks(pc.SHADERLANGUAGE_GLSL).set('gsplatModifyVS', code);
        m.blendState = src.blendState;
        made.push(m.getShaderVariant({
          device: viewer.app.graphicsDevice,
          scene: viewer.app.scene,
          objDefs: mi._shaderDefs,
          cameraShaderParams: camera.shaderParams,
          pass: 0, // SHADER_FORWARD
          sortedLights: [],
          viewUniformFormat: viewer.app.renderer?.viewUniformFormat ?? null,
          vertexFormat: mi.mesh?.vertexBuffer?.format,
        }));
        issued++;
      }
      // the overlay's two quads (created on the first capture otherwise, and compiled on its draw)
      const cam = viewer.eye?.camera?.camera;
      if (cam?.shaderParams) {
        viewer._ensureSnapshotOverlay();
        for (const p of viewer._snap?.parts || []) {
          made.push(p.mat.getShaderVariant?.({
            device: viewer.app.graphicsDevice,
            scene: viewer.app.scene,
            objDefs: p.mi._shaderDefs,
            cameraShaderParams: cam.shaderParams,
            pass: 0,
            sortedLights: [],
            viewUniformFormat: viewer.app.renderer?.viewUniformFormat ?? null,
            vertexFormat: p.mi.mesh?.vertexBuffer?.format,
          }));
        }
      }
      if (issued) prewarmed.add(key);
      await finalizeWhenLinked(made.filter(Boolean));
    } catch (err) {
      console.info('[inline3d/splat] transition shader pre-warm skipped', err);
    }
  }

  /**
   * Creating a program only ISSUES its compile + link; the browser resolves the link when the
   * program is first queried — the engine's first draw, blocking (the 35–50 ms GetProgramiv the
   * trace shows, even for a program created seconds earlier). So finish the engine's own
   * finalize here, in the dwell: wait (in idle periods, not blocking) for the link to complete
   * where the browser reports it (KHR_parallel_shader_compile), then finalize.
   */
  async function finalizeWhenLinked(shaders) {
    const dev = viewer.app?.graphicsDevice;
    if (!dev) return;
    const pending = () => shaders.filter((x) => x && !x.ready && !x.failed && x.impl?.finalize);
    for (let i = 0; i < 40 && pending().length; i++) {
      for (const x of pending()) if (x.impl.isLinked?.(dev)) x.impl.finalize(dev, x) || (x.failed = true);
      if (pending().length) await yieldIdle(50);
      if (removed) return;
    }
    // still linking (or no completion query): finalize now — a block in the dwell, not on the
    // transition's first frame
    for (const x of pending()) x.impl.finalize(dev, x) || (x.failed = true);
  }

  // ── setSource: swap the asset — a cut, a crossfade, or a transition ──
  let sourceGen = 0;
  /** setSource calls between their call and their settle (setVideo refuses to start inside one). */
  let sourceInFlight = 0;
  let pendingSwap = null;
  /** setSource's crossfade FALLBACK: the coverage remap on one entity (null clears it). */
  const setFade = (entity, k) => fx?.setInternal(entity, 'xfade', k === null ? null : { k });
  /**
   * Load `next` behind the current asset, then swap to it:
   *   transition 'cut' (fadeMs 0, the default) — at once;
   *   'crossfade' (fadeMs > 0) — the IMAGES lerp over fadeMs (FRAME_SNAPSHOT);
   *   'flip' — the outgoing photo flattens onto its convergence plane (zero disparity), the swap
   *            happens there, the incoming one inflates out of its own plane;
   *   'wavefront' — a soft front crosses the picture left → right; behind it the new photo, with
   *            a thin depth ridge riding the front.
   * `reveal` (cut/crossfade only) plays an entity-scope reveal on the INCOMING asset while the
   * outgoing one fades. The rig waterfall re-runs for the new file (rig, lens, focus, frame;
   * `onFocusChange` fires); the pose is kept unless `resetPose: true`. A newer call supersedes an
   * older one still loading. Resolves to the handle once the swap has finished.
   */
  function setSource(next, o = {}) {
    // A video owns the tile (display rig, splat hidden) until setVideo(null).
    if (vid) return Promise.reject(new Error(VIDEO_BUSY('setSource')));
    sourceInFlight++;
    return setSourceNow(next, o).finally(() => sourceInFlight--);
  }
  async function setSourceNow(next, o = {}) {
    const plan = resolveSwap(o);
    const { resetPose = false } = o;
    const gen = ++sourceGen;
    // A prepareSource() result: already fetched, decoded and uploaded — no load on this path.
    const prep = preparedAssets.get(next) || null;
    if (prep) {
      if (prep.state !== 'ready') {
        throw new Error(`@displayxr/inline3d/splat: setSource got a prepared source that was already ${prep.state === 'used' ? 'used' : 'disposed'}.`);
      }
      prep.state = 'used';
      livePrepared.delete(prep);
    } else if (next && typeof next === 'object' && next[PREPARED_TAG]) {
      throw new Error('@displayxr/inline3d/splat: setSource got a prepared source from another handle.');
    }
    const app = await booted;
    await first.catch(() => null); // a failed first asset may be replaced
    if (!app || removed) return out;
    const pc = pcModule;
    const loaded = prep ? prep.loaded : await loadOne(pc, app, next);
    if (removed || gen !== sourceGen) {
      app.assets.remove(loaded.asset);
      loaded.asset.unload?.();
      return out;
    }
    const prev = current;
    pendingSwap?.finish();
    const transition = prev ? plan.transition : 'cut';
    const particle = plan.particles && transition in PARTICLE_TRANSITIONS ? plan.particles : null;
    // FRAME_SNAPSHOT: freeze the outgoing frame BEFORE anything of the new asset (or its rig) is
    // drawn. The overlay goes up in the same task, so no frame shows neither photo.
    const wantsSnapshot = transition === 'crossfade' || transition === 'wavefront' || !!particle;
    const snapped = wantsSnapshot ? await viewer.captureFrame() : false;
    if (removed || gen !== sourceGen) {
      app.assets.remove(loaded.asset);
      loaded.asset.unload?.();
      return out;
    }
    if (snapped) viewer.setSnapshotAlpha(1, transition === 'wavefront' ? { t: 0, band: plan.band, views: viewer.viewsAcross } : null);
    // LIVE outgoing (default in 3D): the old asset stays resident and keeps rendering, through the
    // same eye views, into its own target; the frozen capture above bridges the first frames until
    // its camera has drawn a sorted frame. Its lens frame is read BEFORE adopt() switches the rig.
    // A particle transition's outgoing photo MOVES, so it is live in 2D too (where the engine has
    // the RenderView path); 'frozen' there = its snapshot fades out while the new one plays in.
    const outgoingMode = plan.outgoing || (particle ? 'live' : defaultOutgoing(viewer.is3D));
    const live =
      snapped && outgoingMode === 'live' && viewer.canLiveOutgoing ? viewer.startLiveOutgoing(prev.entity, viewer.lensFrame()) : null;
    /** Each frame of the window: once the live camera is ready, the overlay samples it. */
    let liveShown = false;
    const pumpLive = () => {
      if (!live || liveShown || !live.active || !live.ready) return;
      viewer.setSnapshotSource(live.texture);
      liveShown = true;
    };

    const release = (p) => {
      if (!p) return;
      // Disable first, destroy + unload a few frames LATER: the engine's gsplat world keeps the
      // old placement in its list until its next rebuild, and tearing the resource down in the
      // same frame throws inside the engine's update (found by running the swap).
      p.entity.enabled = false;
      fx?.dropEntity(p.entity);
      let frames = 0;
      viewer._hooks.push(() => {
        if (++frames < 4) return true;
        p.entity.destroy?.();
        app.assets.remove(p.asset);
        p.asset.unload?.();
        return false;
      });
    };
    /** The incoming asset becomes THE asset: waterfall, rig, handle fields. */
    const adopt = (entity) => {
      out.mesh = {
        numSplats: loaded.desc.numSplats || loaded.cloud?.sourceTotal || 0,
        entity,
        asset: loaded.asset,
        resource: loaded.res,
      };
      const kept = applyLoaded(loaded);
      current = { asset: loaded.asset, entity, res: loaded.res, kind: loaded.desc.kind, ...kept };
      if (resetPose && !pageMode) viewer.resetPose(); // the page owns the pose on controls:'page'
    };

    const entity = viewer.addSplatAsset(loaded.asset);
    let settle = () => {};
    const done = new Promise((resolve) => (settle = resolve));
    let finished = false;
    const finishers = [];
    const finish = () => {
      if (finished) return;
      finished = true;
      for (const f of finishers) f();
      if (pendingSwap?.finish === finish) pendingSwap = null;
      settle();
    };
    pendingSwap = { finish };

    if (transition === 'flip') {
      // Phase 1: the outgoing photo flattens onto ITS convergence plane under ITS rig; the new
      // asset is resident but hidden (its first frames build its work buffer meanwhile), held
      // flat for phase 2. The rig switches at the flat moment — zero disparity on both sides.
      const half = plan.durationMs / 2;
      setFade(entity, 0);
      let openGate = () => {};
      const gate = new Promise((r) => (openGate = r));
      const flatOut = fx.play('deflate', { durationMs: half, easing: plan.easing, scope: 'entity' }, { entity: prev.entity });
      const inflateIn = fx.play('inflate', { durationMs: half, easing: plan.easing, scope: 'entity' }, { entity, gate });
      finishers.push(() => {
        openGate();
        fx?.stop('inflate', { finish: true, entity });
      });
      flatOut.then(() => {
        if (finished || removed) return;
        setFade(entity, null);
        release(prev);
        adopt(entity);
        afterTicks(2).then(openGate);
      });
      inflateIn.then(finish);
      await done;
      if (current?.entity !== entity && !removed) {
        // superseded before the flat moment: this asset never showed
        release(prev);
        adopt(entity);
      }
      return out;
    }

    if (particle && snapped) {
      playParticleTransition({ particle, plan, prev, entity, live, adopt, release, finishers, finish, isFinished: () => finished, pumpLive, isLiveShown: () => liveShown });
      await done;
      return out;
    }

    adopt(entity);
    if (transition === 'cut') {
      release(prev);
      if (plan.reveal) fx.play(plan.reveal.type, { ...plan.reveal.raw, scope: 'entity' }, { entity, gate: afterTicks(2) });
      finish();
      return out;
    }

    if (transition === 'wavefront' && snapped) {
      if (live) {
        finishers.push(() => {
          viewer.stopLiveOutgoing();
          release(prev);
        });
      } else release(prev); // the snapshot shows it from here on
      const band = plan.band;
      const ridge = fx.play(
        'wavefront',
        { durationMs: plan.durationMs, easing: plan.easing, band, ridge: plan.ridge, ridgeMaxDisparity: plan.ridgeMaxDisparity, scope: 'entity' },
        { entity, gate: afterTicks(2), internal: true },
      );
      finishers.push(() => {
        viewer.setSnapshotAlpha(0);
        viewer.releaseSnapshot();
      });
      viewer._hooks.push(() => {
        if (finished || removed) return false;
        if (live && !live.fits) {
          fx?.stop('wavefront', { finish: true, entity });
          finish();
          return false;
        }
        pumpLive();
        const inst = fx?.scopes.get(entity)?.get('wavefront');
        const amount = inst ? inst.amount : 1;
        if (!viewer.setSnapshotAlpha(1, { t: amount, band, views: viewer.viewsAcross })) {
          fx?.stop('wavefront', { finish: true, entity });
          finish();
          return false;
        }
        return true;
      });
      ridge.then(finish);
      await done;
      return out;
    }

    // crossfade — also the wavefront's fallback when no frame could be captured (a hidden tab):
    // the 1.12.1 one-pass fade, over the same duration.
    const fade = plan.durationMs;
    if (plan.reveal) fx.play(plan.reveal.type, { ...plan.reveal.raw, scope: 'entity' }, { entity, gate: afterTicks(2) });
    if (snapped) {
      if (!live) release(prev); // the snapshot shows it from here on
    } else {
      setFade(entity, 0);
      setFade(prev.entity, 1);
    }
    finishers.push(() => {
      if (snapped) {
        viewer.setSnapshotAlpha(0);
        viewer.releaseSnapshot();
        if (live) {
          viewer.stopLiveOutgoing();
          release(prev);
        }
      } else {
        setFade(entity, null);
        release(prev);
      }
    });
    // The fade clock starts on the SECOND tick after the swap, not now: the first frame that
    // draws the new asset also builds its work buffer (hundreds of ms for a 1M-splat file), and
    // a clock started before it would spend the whole fade inside that one frame — a cut, not a
    // crossfade (found by screenshotting mid-fade).
    let t0 = null;
    let ticks = 0;
    viewer._hooks.push((t) => {
      if (removed) return (finish(), false);
      if (finished) return false; // superseded: already finished
      pumpLive();
      if (++ticks < 2) return true;
      if (t0 === null) t0 = t;
      const k = Math.min(1, Math.max(0, (t - t0) / fade));
      if (snapped) {
        // A resize or a 2D/3D switch mid-fade: the capture no longer fits the buffer — end now.
        if (!viewer.setSnapshotAlpha(1 - k) || (live && !live.fits)) {
          finish();
          return false;
        }
      } else {
        setFade(entity, coverageExponent(k));
        setFade(prev.entity, coverageExponent(1 - k));
      }
      if (k >= 1) {
        finish();
        return false;
      }
      return true;
    });
    await done;
    return out;
  }

  /**
   * setSource's particle transitions (swarm, burst, shimmer-cross, dust), once the frame snapshot
   * is up. The OUTGOING asset plays its effect in reverse, on the live camera, keyed on its own
   * frame (taken here, before the rig switches); the INCOMING one plays forwards on the eye camera,
   * its frame re-taken when the clock starts. One clock drives both, on overlapping spans
   * (particleSpan). The overlay puts the live outgoing image OVER the incoming one, per eye. With
   * no live camera (outgoing:'frozen', or an engine without the RenderView path) the frozen frame
   * fades out over the outgoing span while the incoming asset plays its side. The end: effects
   * removed (modifiers deleted), overlay hidden, live camera off, old asset released — the frame
   * is a plain cut's.
   */
  function playParticleTransition({ particle, plan, prev, entity, live, adopt, release, finishers, finish, isFinished, pumpLive, isLiveShown }) {
    const ease = typeof plan.easing === 'function' ? plan.easing : EASINGS[plan.easing] || EASINGS.linear;
    const overlap = particle.overlap;
    // RENDER-TIME (the default): one tile-scope body, each photo's values on the mesh instance of
    // the gsplat manager that draws it — the eye camera's (incoming) and the live camera's
    // (outgoing). No work-buffer rewrite and no re-sort per frame. An engine that does not expose
    // the managers' mesh instances gets the entity-scope modifiers instead (a full work-buffer
    // rewrite + a re-sort per asset per frame: correct, but it hitches on a 1.18M photo).
    const managerMi = (cam, layer) => {
      const cd = viewer.app?.renderer?.gsplatDirector?.camerasMap?.get?.(cam?.camera?.camera);
      if (!cd?.layersMap) return null;
      if (layer) return cd.layersMap.get(layer)?.gsplatManager?.renderer?.meshInstance ?? null;
      for (const ld of cd.layersMap.values()) if (ld?.gsplatManager?.renderer?.meshInstance) return ld.gsplatManager.renderer.meshInstance;
      return null;
    };
    const eyeMi = () => managerMi(viewer.eye, null);
    const liveMi = () => (live?.active ? managerMi(live.cam, live.layer) : null);
    const shared = particle.out.effect === particle.in.effect && eyeMi() ? fx.driveShared('transition', particle.in.effect, { order: particle.in.opts.order }) : null;
    // the outgoing side, BEFORE adopt(): its frame (eyes, focus, framing) is the old asset's
    let outFx = null;
    if (live) {
      outFx = shared ? shared.side(liveMi, particle.out.opts) : fx.drive(prev.entity, particle.out.effect, particle.out.opts);
      outFx.set(1, 0);
    } else {
      release(prev); // the frozen frame shows it from here on
    }
    adopt(entity);
    // the incoming side, hidden (amount 0) until the clock starts
    const inFx = shared ? shared.side(eyeMi, particle.in.opts) : fx.drive(entity, particle.in.effect, particle.in.opts);
    inFx.set(0, 0);
    viewer._transitionPath = shared ? 'render' : 'entity'; // diagnostics (docs §Gates)
    finishers.push(() => {
      viewer._transitionState = null;
      if (shared) shared.remove();
      else {
        outFx?.remove();
        inFx.remove();
      }
      viewer.setSnapshotAlpha(0);
      viewer.releaseSnapshot();
      if (live) {
        viewer.stopLiveOutgoing();
        release(prev);
      }
    });
    const dur = plan.durationMs;
    let t0 = null;
    let ticks = 0;
    viewer._hooks.push((t) => {
      if (removed) return (finish(), false);
      if (isFinished()) return false;
      if (live && !live.fits) {
        finish(); // a resize or a 2D/3D switch mid-window: end now
        return false;
      }
      pumpLive();
      // The clock starts on the SECOND tick (the incoming asset's first frame builds its work
      // buffer) and, live, once the live camera has drawn a sorted frame (until then the frozen
      // capture stands in for the outgoing photo, untouched).
      if (++ticks < 2 || (live && !isLiveShown())) {
        if (shared) {
          // the managers (and their mesh instances) may be new: keep both photos' values on them
          outFx?.set(1, 0);
          inFx.set(0, 0);
        }
        if (!viewer.setSnapshotAlpha(1)) {
          finish();
          return false;
        }
        return true;
      }
      if (t0 === null) {
        t0 = t;
        inFx.restart(); // the incoming asset's frame, now its rig and first frames are in
      }
      const raw = dur > 0 ? Math.min(1, Math.max(0, (t - t0) / dur)) : 1;
      const te = ease(raw);
      const timeS = (t - t0) / 1000;
      viewer._transitionState = { raw, live: !!live }; // diagnostics (docs §Gates)
      const outSpan = particleSpan(te, overlap, 'out');
      outFx?.set(1 - outSpan, timeS);
      inFx.set(particleSpan(te, overlap, 'in'), timeS);
      const ok = live ? viewer.setSnapshotAlpha(1, null, { over: true }) : viewer.setSnapshotAlpha(1 - outSpan);
      if (!ok || raw >= 1) {
        finish();
        return false;
      }
      return true;
    });
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
/** Marks a prepareSource() result (so one from another handle is caught, not loaded as bytes). */
const PREPARED_TAG = Symbol.for('@displayxr/inline3d/splat.prepared');

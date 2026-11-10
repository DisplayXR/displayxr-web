// inline3d-rig-hint.js — a one-time console hint for a CAMERA rig that orbits a fixed point. Internal (not a public
// entry): inline3d.js calls it from handle.setViewRig. Read only — the rig is never changed.
//
// Why: the most common rig mistake on a page that frames a SUBJECT is reaching for the camera rig
// because the page owns a camera. An orbit camera then hands the runtime a convergence distance
// the page has to keep in sync with its camera, and anything that moves the camera (a resize
// refit, a zoom, a layout breakpoint) leaves the glass at a stale depth. A display rig posed at
// the orbit target has no convergence to keep in sync. docs/authoring-inline-3d.md, "Which rig".

/** How far the camera must swing around a fixed convergence point before we say anything. */
export const ORBIT_HINT_ANGLE = Math.PI / 4;
/** How still the convergence point must stay, as a fraction of the convergence distance. */
export const ORBIT_HINT_DRIFT = 0.05;

export const ORBIT_HINT_MSG =
  '[inline3d] This camera rig orbits a fixed point: its convergence point stayed put while the camera swung ' +
  '45° around it. If the user is turning a SUBJECT (a model, a diorama, a simulation), a DISPLAY rig fits better: ' +
  'pose the portal at the orbit target, e.g. displayRig({ position: target, orientation: camera.quaternion, ' +
  'virtualDisplayHeight: 2 * distance * Math.tan(fovRadians / 2) }), and the target stays on the glass at any ' +
  'window size and zoom, with no convergence to keep in sync. See docs/authoring-inline-3d.md, "Which rig". ' +
  'A walkthrough, a game or a map keeps its camera rig. The rig is sent as given.';

/** Rotate (0, 0, -1) by quaternion q: a camera's forward axis. */
function forward(q) {
  const x = q.x || 0, y = q.y || 0, z = q.z || 0, w = q.w === undefined ? 1 : q.w;
  return [-2 * (x * z + w * y), -2 * (y * z - w * x), -(1 - 2 * (x * x + y * y))];
}

/**
 * Feed every camera rig a handle sends. Logs ORBIT_HINT_MSG with console.info at most once per
 * `state` (one per handle). Returns true on the call that logged.
 *
 * @param {object} state  per-handle scratch object (start with {}).
 * @param {object} rig    the descriptor as sent.
 */
export function noteCameraRigOrbit(state, rig) {
  if (state.done || !rig || rig.type !== 'camera' || !(rig.convergenceDiopters > 0)) return false;
  const p = rig.position || {}, q = rig.orientation || {};
  const px = p.x || 0, py = p.y || 0, pz = p.z || 0;
  const d = 1 / rig.convergenceDiopters;
  const f = forward(q);
  const c = [px + f[0] * d, py + f[1] * d, pz + f[2] * d]; // the convergence point
  const o = state.orbit;
  const drift = o ? Math.hypot(c[0] - o.c[0], c[1] - o.c[1], c[2] - o.c[2]) : Infinity;
  if (!o || drift > ORBIT_HINT_DRIFT * Math.max(d, o.d)) {
    state.orbit = { c, d, dir: [-f[0], -f[1], -f[2]] }; // camera direction as seen from c
    return false;
  }
  // The angle the camera has swung around c since the convergence point last moved.
  const cos = -(f[0] * o.dir[0] + f[1] * o.dir[1] + f[2] * o.dir[2]);
  if (Math.acos(Math.max(-1, Math.min(1, cos))) < ORBIT_HINT_ANGLE) return false;
  state.done = true;
  console.info(ORBIT_HINT_MSG);
  return true;
}

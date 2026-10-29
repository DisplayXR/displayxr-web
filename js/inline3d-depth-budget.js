// inline3d-depth-budget.js — how deep is this scene, in the units a 3D display cares about.
//
// Pure functions, dependency-free, re-exported by ./inline3d.js (the root), ./three and the
// `./depth` subpath. NOTHING HERE CHANGES A PIXEL: these are measurements, plus one-time warnings.
// The SDK never clamps, refuses or overrides a depth a page asked for.
//
// The units are relative, which is what makes them portable across panels: disparity as a
// percentage of the TILE's width, or depth in TILE HEIGHTS on a display rig (where the canvas is a
// portal and world depth / virtualDisplayHeight equals physical depth / the tile's physical
// height). Depth ranges measured on a panel are in docs/authoring-inline-3d.md; they are reference
// points, not limits this module applies.
//
// The conversion on a display rig: physical depth z = depthH · h (h = the tile's physical height),
// on-screen disparity p = e · z / (V ∓ z) (e = 0.063 m, V = the nominal viewer distance, − in
// front, + behind), as a percentage of the tile width w = aspect · h. When h is unknown the
// small-depth limit p ≈ e · z / V is used, in which h cancels: pct ≈ 100 · e · depthH / (aspect · V).

/** The eye separation every estimate here assumes (no browser surface reports a real one). */
export const DEPTH_EYE_SEPARATION_M = 0.063;

/** The viewer distance used when the display does not report its nominal viewer (desktop panel). */
export const DEPTH_DEFAULT_VIEWER_M = 0.6;

const num = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Disparity, % of the tile width, of a point `depthH` tile heights out of the glass on a display
 * rig. SIGNED like display space: `depthH > 0` is IN FRONT (toward the viewer) and gives a NEGATIVE
 * (crossed) disparity; `depthH < 0` is behind and gives a positive one — the same sign as
 * {@link cameraRigDisparityPct}.
 *
 * @param {object} o
 * @param {number} o.depthH  tile heights out of the glass (+ in front, − behind).
 * @param {number} o.aspect  the tile's width / height.
 * @param {number} [o.viewerM=0.6]  nominal viewer distance, metres.
 * @param {number} [o.heightM]  the tile's physical height, metres. Unset: the small-depth limit.
 * @param {number} [o.ipdFactor=1]  a display rig's ipdFactor (disparity scales with it).
 * @param {number} [o.eyeSeparationM=0.063]
 * @returns {number} %, −Infinity at or past the viewer, NaN on bad input.
 */
export function disparityPct({ depthH, aspect, viewerM = DEPTH_DEFAULT_VIEWER_M, heightM, ipdFactor = 1, eyeSeparationM = DEPTH_EYE_SEPARATION_M } = {}) {
  if (!num(depthH) || !num(aspect) || !(aspect > 0) || !num(viewerM) || !(viewerM > 0) || !num(ipdFactor)) return NaN;
  const h = num(heightM) && heightM > 0 ? heightM : 0;
  const denom = viewerM - depthH * h;
  if (!(denom > 0)) return -Infinity;
  if (depthH === 0) return 0;
  return (-100 * eyeSeparationM * ipdFactor * depthH) / (aspect * denom);
}

/**
 * Disparity, % of the tile width, of a point at distance `z` on a CAMERA rig:
 * `100 · b · (1/D − 1/z) / (2 · tan(verticalFov/2) · aspect)`, `b = 0.063 · ipdFactor · metersToVirtual`,
 * D the convergence distance. `+` = behind the glass, `−` = in front. Convergence 0 / unset is
 * infinity (1/D = 0): everything is in front.
 *
 * @param {object} o
 * @param {number} o.z  distance of the point along the camera's view axis, world units.
 * @param {number} [o.convergence]  zero-disparity distance, world units (0 = infinity).
 * @param {number} [o.convergenceDiopters]  or 1/distance, as the descriptor carries it.
 * @param {number} [o.ipdFactor=1] [o.metersToVirtual=1]
 * @param {number} o.verticalFov  FULL vertical angle, RADIANS (the descriptor's unit).
 * @param {number} o.aspect  the tile's width / height.
 * @returns {number} %, NaN on bad input.
 */
export function cameraRigDisparityPct({ z, convergence, convergenceDiopters, ipdFactor = 1, metersToVirtual = 1, verticalFov, aspect } = {}) {
  if (!num(z) || !(z > 0) || !num(verticalFov) || !(verticalFov > 0) || !num(aspect) || !(aspect > 0)) return NaN;
  if (!num(ipdFactor) || !num(metersToVirtual)) return NaN;
  const invD = num(convergenceDiopters) ? Math.max(0, convergenceDiopters) : num(convergence) && convergence > 0 ? 1 / convergence : 0;
  const b = DEPTH_EYE_SEPARATION_M * ipdFactor * metersToVirtual;
  return (100 * b * (invD - 1 / z)) / (2 * Math.tan(verticalFov / 2) * aspect);
}

/**
 * A depth report from a display-rig subject box (SceneViewer.getSubjectBounds' `front` / `back`,
 * display space: +z toward the viewer, glass at 0, units of the virtual display).
 *
 * `frontH` / `backH` are MAGNITUDES in tile heights: how far the nearest point sits in front of the
 * glass and the farthest behind it (0 when nothing is on that side). `frontPct` / `backPct` are the
 * matching disparity magnitudes, % of the tile width.
 *
 * @param {object} o
 * @param {number} o.front  z of the nearest surface.
 * @param {number} o.back  z of the farthest surface.
 * @param {number} o.virtualDisplayHeight  what one tile height is in those units.
 * @param {number} o.aspect  the tile's width / height.
 * @param {number} [o.viewerM=0.6] [o.heightM] [o.ipdFactor=1]  as {@link disparityPct}.
 */
export function depthBudgetFromBounds({ front, back, virtualDisplayHeight, aspect, viewerM = DEPTH_DEFAULT_VIEWER_M, heightM, ipdFactor = 1 } = {}) {
  const vH = virtualDisplayHeight;
  const ok = num(front) && num(back) && num(vH) && vH > 0;
  const frontH = ok ? Math.max(0, front / vH) : NaN;
  const backH = ok ? Math.max(0, -back / vH) : NaN;
  const common = { aspect, viewerM, heightM, ipdFactor };
  const frontPct = Math.abs(disparityPct({ depthH: frontH, ...common }));
  const backPct = Math.abs(disparityPct({ depthH: -backH, ...common }));
  return {
    frontH,
    backH,
    frontPct,
    backPct,
    basis: {
      rig: 'display',
      aspect,
      viewerM,
      heightM: num(heightM) && heightM > 0 ? heightM : null,
      ipdFactor,
      eyeSeparationM: DEPTH_EYE_SEPARATION_M,
    },
  };
}

// ── one-time warnings (never a behaviour change) ──────────────────────────────────────────────

const CONVERGENCE_MSG =
  '[inline3d] camera rig with convergenceDiopters 0: convergence at infinity puts the whole scene in front of the glass; ' +
  'set convergence to the subject\'s distance.';

/** Descriptors a rig builder already warned about, so setViewRig does not say it twice. */
const builderWarned = new WeakSet();
let builderWarnedOnce = false;

/** cameraRigFromCamera / cameraRigFromPose: warn once per page when convergence is 0 / unset. */
export function noteBuiltCameraRig(rig) {
  if (rig.convergenceDiopters > 0) return;
  if (!builderWarnedOnce) {
    builderWarnedOnce = true;
    console.warn(CONVERGENCE_MSG);
  }
  builderWarned.add(rig);
}

/**
 * What looks wrong about a view-rig descriptor: `[key, message]` pairs (key = 'convergence' |
 * 'factor' | 'fov'). Read only; the descriptor goes to the runtime exactly as given.
 */
export function viewRigWarnings(rig) {
  const out = [];
  if (!rig || typeof rig !== 'object') return out;
  if (rig.type === 'camera') {
    if (!(rig.convergenceDiopters > 0)) out.push(['convergence', CONVERGENCE_MSG]);
    if (rig.verticalFov > Math.PI) {
      out.push([
        'fov',
        `[inline3d] camera rig verticalFov ${rig.verticalFov} is more than π: it looks like DEGREES — the descriptor takes RADIANS ` +
          '(cameraRigFromCamera / cameraRigFromPose convert three\'s degrees for you).',
      ]);
    }
  } else if (rig.ipdFactor > 1 || rig.parallaxFactor > 1) {
    out.push([
      'factor',
      `[inline3d] display rig ipdFactor ${rig.ipdFactor ?? 1} / parallaxFactor ${rig.parallaxFactor ?? 1}: above 1 exaggerates ` +
        'depth past what the display shows by construction (1 = correct; below 1 = a comfort dial). Sent as given.',
    ]);
  }
  return out;
}

/** Warn each of viewRigWarnings(rig) once per `seen` set (one per handle). */
export function warnViewRigOnce(seen, rig) {
  if (!rig || typeof rig !== 'object') return;
  // The cheap common case first: called per frame by pages that drive a rig.
  if (rig.type === 'camera' ? rig.convergenceDiopters > 0 && !(rig.verticalFov > Math.PI) : !(rig.ipdFactor > 1 || rig.parallaxFactor > 1)) return;
  for (const [key, msg] of viewRigWarnings(rig)) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (key === 'convergence' && builderWarned.has(rig)) continue; // the builder said it already
    console.warn(msg);
  }
}

/**
 * The hint for a `wovenState === 'withheld'` reason token (docs/woven-canvas-rules.md §3).
 */
export function withheldReasonHint(reason) {
  const r = String(reason || '');
  if (r.startsWith('cross-pass')) {
    return 'the canvas is inside its own render surface: a CSS effect on it or an ancestor (filter, opacity < 1, mask, clip-path, mix-blend-mode, backdrop-filter). Remove it (woven-canvas rule 7)';
  }
  if (r === 'no-quad') {
    return 'the canvas drew nothing the compositor can see: it is not drawing, is occluded, or a CSS effect on it or an ancestor (filter, opacity < 1, mask, clip-path, mix-blend-mode, backdrop-filter) hides it (woven-canvas rule 7)';
  }
  if (r === 'no-identity') return 'the canvas reached the browser without its identity: register it once, keep it mounted, cover it until firstWoven (woven-canvas rules 3-5)';
  if (r === 'no-join') return 'nothing joined this rect; harmless off screen, otherwise check the canvas is drawing and on screen';
  if (r === 'resolve-dropped') return "the browser could not resolve the canvas's GPU resource (a browser-side issue)";
  return 'see docs/woven-canvas-rules.md §3';
}

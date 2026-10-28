// inline3d-depth-budget.js — how deep is this scene, in the units a 3D display cares about.
//
// Pure functions, dependency-free, re-exported by ./inline3d.js (the root), ./three and the
// `./depth` subpath. NOTHING HERE CHANGES A PIXEL: these are measurements and opt-in fits. The SDK
// never clamps, refuses or overrides a depth a page asked for; a page that wants a budget asks for
// one (`depthFit`) or reads one (`depthReport()`, the helpers below) and decides for itself.
//
// THE BUDGET is relative, which is what makes it portable across panels: disparity as a percentage
// of the TILE's width, or depth in TILE HEIGHTS on a display rig (where the canvas is a portal and
// world depth / virtualDisplayHeight equals physical depth / the tile's physical height).
//
//                     in FRONT of the glass        BEHIND the glass
//   comfortable       <= 0.6 % (~0.1 h)             <= 1.5 % (~0.27 h)
//   strong            <= 1.1 % (~0.18 h)            <= 2.3 % (~0.45 h)
//   hard human limit  ~3.3 % either way (~0.3 D of vergence at 0.6 m)
//
// and ~0 near the frame edges (a subject cut by the frame while in front of it reads as broken).
//
// The conversion on a display rig: physical depth z = depthH · h (h = the tile's physical height),
// on-screen disparity p = e · z / (V ∓ z) (e = 0.063 m, V = the nominal viewer distance, − in
// front, + behind), as a percentage of the tile width w = aspect · h. When h is unknown the
// small-depth limit p ≈ e · z / V is used, in which h cancels: pct ≈ 100 · e · depthH / (aspect · V).

/** The eye separation every estimate here assumes (no browser surface reports a real one). */
export const DEPTH_EYE_SEPARATION_M = 0.063;

/** The viewer distance used when the display does not report its nominal viewer (desktop panel). */
export const DEPTH_DEFAULT_VIEWER_M = 0.6;

/**
 * The relative depth budget, as disparity in % of the tile width (`*Pct`) and the display-rig
 * depth it corresponds to in tile heights (`*H`, on a 16:9 tile at 0.6 m — the `%` is the budget,
 * the `H` its usual translation). `limitPct` is the hard human fusion limit.
 */
export const DEPTH_BUDGET = Object.freeze({
  comfortable: Object.freeze({ frontPct: 0.6, backPct: 1.5, frontH: 0.1, backH: 0.27 }),
  strong: Object.freeze({ frontPct: 1.1, backPct: 2.3, frontH: 0.18, backH: 0.45 }),
  limitPct: 3.3,
});

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

/** 'comfortable' | 'strong' | 'beyond' for disparity magnitudes (%) in front and behind. */
export function depthBudgetClass(frontPct, backPct) {
  const f = Math.abs(frontPct) || 0;
  const b = Math.abs(backPct) || 0;
  const C = DEPTH_BUDGET.comfortable;
  const S = DEPTH_BUDGET.strong;
  if (f <= C.frontPct && b <= C.backPct) return 'comfortable';
  if (f <= S.frontPct && b <= S.backPct) return 'strong';
  return 'beyond';
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
    budget: Number.isNaN(frontPct) || Number.isNaN(backPct) ? 'beyond' : depthBudgetClass(frontPct, backPct),
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

// ── depthFit (SceneViewer / the PlayCanvas viewer, opt-in) ────────────────────────────────────

/**
 * The `depthFit` option, validated. Null / undefined = off (today's fit, exactly). Otherwise
 * `{ front, back }` in TILE HEIGHTS, each a finite number >= 0; a side left out is unbounded.
 * Throws a TypeError on anything else, at the call.
 */
export function validateDepthFit(v, tag = '@displayxr/inline3d/viewer') {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object') throw new TypeError(`${tag}: depthFit must be { front, back } in tile heights, or null.`);
  const out = { front: Infinity, back: Infinity };
  for (const k of ['front', 'back']) {
    if (v[k] === undefined || v[k] === null) continue;
    if (!num(v[k]) || v[k] < 0) throw new TypeError(`${tag}: depthFit.${k} must be a finite number >= 0 (tile heights), got ${v[k]}.`);
    out[k] = v[k];
  }
  return out;
}

/**
 * The largest uniform scale that keeps a subject of half-depth `halfDepth` (model units), centred
 * at `depthOffset` (display units, + toward the viewer), within `front` tile heights in front of
 * the glass and `back` behind it. Infinity when nothing binds; null when the placement alone
 * (`depthOffset`) is already past a bound, so no scale can satisfy it — the caller then keeps its
 * size fit (never scales to nothing).
 */
export function depthFitScale({ halfDepth, virtualDisplayHeight, depthOffset = 0, front = Infinity, back = Infinity }) {
  const hd = Math.max(halfDepth, 1e-9);
  const vH = virtualDisplayHeight;
  const d = num(depthOffset) ? depthOffset : 0;
  let s = Infinity;
  if (front !== Infinity) {
    const room = front * vH - d;
    if (!(room > 0)) return null;
    s = Math.min(s, room / hd);
  }
  if (back !== Infinity) {
    const room = back * vH + d;
    if (!(room > 0)) return null;
    s = Math.min(s, room / hd);
  }
  return s;
}

/**
 * The depth-axis half-extent a fit must budget for: with `sweep` (the viewer's `fitSweep`, i.e.
 * the subject will turn about Y) the worst over every yaw, hypot(hx, hz) — the same bound the
 * width fit uses; otherwise hz.
 */
export function fitHalfDepth(half, sweep) {
  return sweep ? Math.hypot(half[0], half[2]) : half[2];
}

/**
 * Apply `depthFit` to a size-fit scale `s` for a viewer (SceneViewer or the PlayCanvas viewer):
 * the result is never larger than `s`. Warns once per viewer when the placement alone breaks the
 * budget (and then leaves `s` alone).
 */
export function applyDepthFit(viewer, s, half) {
  const df = viewer.depthFit;
  if (!df) return s;
  const cap = depthFitScale({
    halfDepth: fitHalfDepth(half, viewer.fitSweep),
    virtualDisplayHeight: viewer.vH,
    depthOffset: viewer._depthOffset,
    front: df.front,
    back: df.back,
  });
  if (cap === null) {
    if (!viewer._warnedDepthFit) {
      viewer._warnedDepthFit = true;
      console.warn(
        `${viewer.logTag || '[inline3d]'} depthFit: depthOffset ${viewer._depthOffset} alone puts the subject past ` +
          `the budget (front ${df.front} h, back ${df.back} h); the size fit is kept as is.`,
      );
    }
    return s;
  }
  return cap < s ? cap : s;
}

// ── depthReport (the scene handles) ───────────────────────────────────────────────────────────

/**
 * A `handle.depthReport()` for a viewer with getSubjectBounds(). `getTile()` → the core TileHandle
 * (or null without a session), `ipdFactor()` → the declared display rig's ipdFactor, `available()`
 * → false while there is nothing display-rig to report (a camera rig, `controls: 'page'`): the
 * report is then null. Display info is read once, lazily: the first report uses the defaults
 * (`basis.viewerSource: 'default'`, the small-depth formula), later ones the display's own.
 */
export function makeDepthReport(viewer, { canvas, getTile = () => null, ipdFactor = () => 1, available = () => true }) {
  let info = null;
  let asked = false;
  return function depthReport() {
    if (!viewer || typeof viewer.getSubjectBounds !== 'function' || !available()) return null;
    // Asked once a window exists; asked again later if it answered nothing (no frame yet).
    const tile = asked || info ? null : getTile();
    if (tile && typeof tile.getDisplayInfo === 'function') {
      asked = true;
      try {
        const p = tile.getDisplayInfo();
        if (p && typeof p.then === 'function') p.then((i) => ((info = i || null), (asked = !!i)), () => {});
      } catch {
        /* no display API: the defaults */
      }
    }
    const b = viewer.getSubjectBounds();
    const box = canvas?.getBoundingClientRect?.() || { width: 0, height: 0 };
    const aspect = box.height > 0 ? box.width / box.height : 1;
    const z = info?.nominalViewerPosition?.z;
    const viewerOk = num(z) && z > 0.1;
    const okSize = info && info.displayHeightMeters > 0 && info.displayPixelHeight > 0;
    const dpr = (typeof globalThis.devicePixelRatio === 'number' && globalThis.devicePixelRatio) || globalThis.window?.devicePixelRatio || 1;
    const heightM = okSize && box.height > 0 ? (box.height * dpr * info.displayHeightMeters) / info.displayPixelHeight : undefined;
    const r = depthBudgetFromBounds({
      front: b.front,
      back: b.back,
      virtualDisplayHeight: viewer.vH,
      aspect,
      viewerM: viewerOk ? z : DEPTH_DEFAULT_VIEWER_M,
      heightM,
      ipdFactor: ipdFactor(),
    });
    r.basis.viewerSource = viewerOk ? 'display' : 'default';
    return r;
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

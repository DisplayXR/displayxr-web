// inline3d-display-metrics.js — a tile in PHYSICAL units, from XRDisplayInfo.
//
// What TileHandle.displayMetrics() resolves, as a pure function, so ./splat's depth envelope (and
// a page) can share it without pulling in the core. Dependency-free; re-exported by ./inline3d.js.

/**
 * The defaults displayMetrics() fills in what the display cannot report: a 15.6" 16:9 panel at
 * 1920x1080 CSS px, the viewer at 650 mm, eyes 63 mm apart. EYE SEPARATION IS ALWAYS A DEFAULT —
 * no browser or runtime surface reports one (the runtime tracks eye POSITIONS; a page cannot read
 * them) — so `source.eyeSeparation` is always 'default' today.
 */
export const DISPLAY_METRICS_DEFAULTS = Object.freeze({
  displaySizeM: Object.freeze([0.3456, 0.1944]),
  displayPixels: Object.freeze([1920, 1080]),
  nominalViewerM: 0.65,
  eyeSeparationM: 0.063,
});

/**
 * displayMetrics() as a pure function: `info` an XRDisplayInfo (or null), `rect` the canvas's
 * client rect (CSS px), `dpr` window.devicePixelRatio. Physical px pitch = displayWidthMeters /
 * displayPixelWidth (the same per axis), and one CSS px is `dpr` physical px — exact when the
 * browser window is on the panel at its native resolution, which is the only place a woven tile
 * draws in 3D.
 */
export function displayMetricsFrom(info, rect, dpr = 1) {
  const D = DISPLAY_METRICS_DEFAULTS;
  const ok =
    !!info &&
    info.displayWidthMeters > 0 &&
    info.displayHeightMeters > 0 &&
    info.displayPixelWidth > 0 &&
    info.displayPixelHeight > 0;
  const displaySizeM = ok ? [info.displayWidthMeters, info.displayHeightMeters] : [...D.displaySizeM];
  const px = ok ? [info.displayPixelWidth, info.displayPixelHeight] : [...D.displayPixels];
  // Per axis, then their mean: a panel's pixels are square to well under a percent, and one
  // number per CSS px is what a page converting a DOM rect wants.
  const pitch = ((displaySizeM[0] / px[0]) + (displaySizeM[1] / px[1])) / 2;
  const d = dpr > 0 ? dpr : 1;
  const metersPerCssPx = ok ? pitch * d : pitch * (px[1] / Math.max(1, globalThis.innerHeight || px[1]));
  const z = info?.nominalViewerPosition?.z;
  const viewerOk = Number.isFinite(z) && z > 0.1;
  return {
    canvasSizeM: [(rect?.width || 0) * metersPerCssPx, (rect?.height || 0) * metersPerCssPx],
    metersPerCssPx,
    displaySizeM,
    nominalViewerM: viewerOk ? z : D.nominalViewerM,
    eyeSeparationM: D.eyeSeparationM,
    source: { size: ok ? 'display' : 'default', viewer: viewerOk ? 'display' : 'default', eyeSeparation: 'default' },
  };
}

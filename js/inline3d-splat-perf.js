// inline3d-splat-perf.js — cut a Gaussian splat's OVERDRAW, for `./splat`.
//
// EXPERIMENTAL. Internal to `./splat`, which re-exports `applySplatPerf` and takes `perf` as an
// option. Not covered by the SDK's 1.x semver promise — see docs/sdk-stability.md.
//
// WHAT COSTS WHAT. On a 1.18M-gaussian photo-lifted scene the per-fragment composite is 75–85 %
// of the frame (measured natively on an M1 Pro, one eye at 1920×1080), and it is OVERDRAW, not
// resolution: a handful of enormous, nearly transparent sky splats cover the frame many times
// over. Splat COUNT is the axis everyone reaches for first and it is the wrong one — decimating
// this asset to 25 % breaks it visibly (bright stipple on near lit surfaces) while removing far
// less fill than the two changes below, which remove none of the picture at all.
//
// The two that matter, in the native renderer's words: **shrink each splat's quad to the radius
// where its alpha falls below 1/255**, instead of a fixed 3σ, and **cull gaussians whose peak
// opacity is already below 1/255**. This module is both of those on Spark.
//
// WHY THE FIRST ONE IS FREE. Spark draws every splat as a quad of `maxStdDev` σ (default √8 ≈
// 2.83σ) and its fragment shader then discards any fragment whose alpha has fallen under
// `minAlpha` — so for a splat of peak alpha `a` every fragment beyond
//
//     r = sqrt(2 · ln(a / minAlpha))
//
// is ALREADY being discarded. It is rasterised, interpolated, shaded, and thrown away. Shrinking
// the quad to exactly that radius therefore removes fragments that contributed nothing: the
// output is bit-identical (see `alphaRadius` below for the two conditions), and the saving is
// biggest on exactly the splats that dominate the cost — a haze splat of a = 0.02 needs 1.81σ,
// not 2.83σ, which is 2.4× fewer fragments for the same pixels.
//
// Spark 2.1.0 has no option for that (`maxStdDev` is ONE global uniform, and nothing in the
// shader derives a radius from alpha), so this patches the vertex shader — through the supported
// `vertexShader` surface, and by REWRITING SPARK'S OWN SOURCE off the live material rather than
// shipping a copy of it, so a Spark upgrade brings its shader fixes with it instead of silently
// pinning this SDK to a fork of a 2.1.0 file. If the anchors ever stop matching, the patch
// declines with one warning and everything still renders.

/**
 * Where a splat's alpha has to fall before its quad may be cut, as a fraction of full opacity.
 *
 * 1/255 is the native renderer's threshold and the point below which an 8-bit framebuffer cannot
 * represent the contribution at all. Note Spark's own `minAlpha` default is HALF of this
 * (0.5/255) — deliberately, so its discard is a shade conservative — which is why `minAlpha` is
 * a knob here and not an assumption.
 */
const ALPHA_FLOOR = 1 / 255;

/**
 * Presets. `balanced` is native parity — the quad shrink plus the 1/255 opacity cull, and
 * nothing else. `aggressive` adds the two knobs that DO drop picture, for a mobile tier.
 *
 * Nothing here is applied unless a caller asks for it: `addSplat` with no `perf` leaves every
 * Spark default exactly where Spark put it.
 */
export const SPLAT_PERF_PRESETS = {
  balanced: {
    alphaRadius: true,
    minAlpha: ALPHA_FLOOR,
  },
  aggressive: {
    alphaRadius: true,
    minAlpha: ALPHA_FLOOR,
    // The per-splat version of shrinking every quad: cut each tail where IT reaches 4/255
    // instead of 1/255. Strictly better than turning `maxStdDev` down by the same amount,
    // because it takes the radius from the splats whose tails are invisible and leaves the
    // opaque ones alone — and on a capture of mostly-opaque gaussians (which is what a lifted
    // photograph is) it is the only one of the two that is not a flat truncation.
    alphaFloor: 4 / 255,
    // Sub-pixel splats: both eigenaxes under a pixel. They are the grain of a capture, so this
    // is visible on a still — it is here for a phone, not for a hero.
    minPixelRadius: 1,
    // 2.45σ instead of 2.83σ: −25 % fragments on every splat, including the opaque ones whose
    // tails this genuinely truncates. Spark's own docs sanction √4…√9.
    maxStdDev: Math.sqrt(6),
  },
};

/** Fields that are plain properties on SparkRenderer, copied into uniforms every frame. */
const SPARK_FIELDS = [
  'minAlpha',
  'maxStdDev',
  'minPixelRadius',
  'maxPixelRadius',
  'falloff',
  // LOD budget knobs. Live, but inert unless the MESH was loaded with LOD data — see
  // splatPerfMeshOptions().
  'lodSplatCount',
  'lodSplatScale',
  'lodRenderScale',
];

// The two anchors the shader patch needs, quoted from Spark 2.1.0's `splatVertex.glsl`.
//
//   `vRgba.a = rgba.a;` is the line AFTER the anti-aliasing blur has been folded into the alpha
//   (`rgba.a *= blurAdjust`) — so at that point `rgba.a` is exactly the alpha the fragment shader
//   will interpolate, which is what makes the derived radius exact rather than approximate. It is
//   also after the eigen-decomposition's inputs are final and BEFORE `scale1`/`scale2` are taken
//   from `adjustedStdDev`, which is the only window where writing it has any effect.
const ANCHOR_ALPHA = '    vRgba.a = rgba.a;\n';
const ANCHOR_UNIFORM = 'uniform float minAlpha;\n';

/**
 * Rewrite Spark's splat vertex shader so each quad is only as big as its own alpha justifies.
 *
 * `falloff` is read (not assumed) because the whole argument rests on the fragment shader's
 * `a·exp(−z²/2)` decay: at `falloff < 1` the alpha does NOT decay across the quad, nothing is
 * being discarded, and cutting the quad would cut the picture. The uniform is shared between the
 * two stages, so the vertex shader only has to declare it.
 *
 * @returns {boolean} whether the patch went in.
 */
function patchAlphaRadius(material) {
  const src = material?.vertexShader;
  if (typeof src !== 'string') return false;
  if (src.includes('dxrAlphaRadius')) return true; // idempotent — a shared material, or a re-apply
  if (!src.includes(ANCHOR_ALPHA) || !src.includes(ANCHOR_UNIFORM)) {
    console.warn(
      '[inline3d/splat] perf.alphaRadius: this build of Spark does not have the shader lines ' +
        'this patch rewrites, so the quad-shrink is SKIPPED (everything else still applies, and ' +
        'the picture is unchanged). Report the Spark version — the anchors are versioned in ' +
        'js/inline3d-splat-perf.js.',
    );
    return false;
  }
  material.vertexShader = src
    .replace(
      ANCHOR_UNIFORM,
      `${ANCHOR_UNIFORM}uniform float falloff;\nuniform bool dxrAlphaRadius;\nuniform float dxrAlphaFloor;\n`,
    )
    .replace(
      ANCHOR_ALPHA,
      `${ANCHOR_ALPHA}
    // @displayxr/inline3d: shrink the quad to where this splat's own alpha reaches minAlpha.
    // Every fragment outside that radius is discarded by the fragment shader anyway, so this
    // removes work and not pixels. Guarded on falloff == 1, which is what makes that true.
    if (dxrAlphaRadius && (falloff == 1.0) && (rgba.a <= 1.0)) {
        float floorA = max(dxrAlphaFloor > 0.0 ? dxrAlphaFloor : minAlpha, 1e-6);
        adjustedStdDev = min(adjustedStdDev, sqrt(max(0.0, 2.0 * log(rgba.a / floorA))));
        vSplatUv = position.xy * adjustedStdDev;
    }
`,
    );
  material.uniforms.dxrAlphaRadius = { value: true };
  // 0 means "use minAlpha", which is the bit-exact cut. See `alphaFloor`.
  material.uniforms.dxrAlphaFloor = { value: 0 };
  material.needsUpdate = true;
  return true;
}

/**
 * Apply a perf profile to a live `SparkRenderer`.
 *
 * Exported for pages that build their own Spark renderer instead of going through `addSplat`
 * — the knobs are all live, so this can be called at any time (a quality menu, a battery-saver
 * toggle) and takes effect on the next frame.
 *
 * | option | default (Spark 2.1.0) | effect | safety |
 * |---|---|---|---|
 * | `alphaRadius` | — (no such thing) | quad shrunk to the splat's own `alphaFloor` radius | **bit-exact** at the default floor, see below |
 * | `alphaFloor` | — (= `minAlpha`) | the alpha the tail may be cut at, PER SPLAT | lossy above `minAlpha`, and gently: it spends radius where the splat is opaque and takes it where it is not |
 * | `minAlpha` | `0.5/255` | splats and fragments under this alpha are dropped | lossy under 1 LSB |
 * | `maxStdDev` | `√8` | quad extent in σ, globally | lossy: truncates opaque tails |
 * | `minPixelRadius` | `0` | drop splats under this size in px | lossy: drops fine grain |
 * | `maxPixelRadius` | `512` | clamp on quad size in px | lossy, and it SQUASHES: the profile is compressed into the smaller quad, not clipped |
 * | `falloff` | `1` | 1 = Gaussian, 0 = flat | NOT a perf knob — 0 makes the fragment discard stop firing, which costs MORE |
 *
 * BIT-EXACT, and the two conditions on that word. `alphaRadius` only removes fragments the
 * fragment shader was already discarding, so the composited image does not change — provided
 * `falloff` is 1 (the shader guards this itself) and `minPixelRadius` is 0. With a non-zero
 * `minPixelRadius` the shrunken quad can fall under it and the splat is then dropped outright,
 * which is a real (small) change; that is why `balanced` leaves it at 0. At the discard boundary
 * itself the two sides can disagree by one float ULP, where the fragment's own contribution is
 * below 1/255 by construction — invisible in 8 bits, but "bit-exact" is stated with that caveat
 * rather than without it.
 *
 * @param {object} spark  a SparkRenderer.
 * @param {true|'balanced'|'aggressive'|object} perf
 * @returns {object|null} the profile actually applied.
 */
export function applySplatPerf(spark, perf) {
  if (!spark || !perf) return null;
  let profile;
  if (perf === true) profile = SPLAT_PERF_PRESETS.balanced;
  else if (typeof perf === 'string') profile = SPLAT_PERF_PRESETS[perf];
  else if (typeof perf === 'object') profile = perf;
  if (!profile) {
    console.warn(
      `[inline3d/splat] unknown perf preset "${perf}" — ignored. ` +
        `Known: ${Object.keys(SPLAT_PERF_PRESETS).join(', ')}, or an options object.`,
    );
    return null;
  }

  const applied = {};
  for (const key of SPARK_FIELDS) {
    if (typeof profile[key] === 'number' && Number.isFinite(profile[key])) {
      spark[key] = profile[key];
      applied[key] = profile[key];
    }
  }
  if (profile.alphaRadius) patchAlphaRadius(spark.material);
  const floorU = spark.material?.uniforms?.dxrAlphaFloor;
  if (floorU && profile.alphaFloor !== undefined) {
    floorU.value = Number.isFinite(profile.alphaFloor) ? profile.alphaFloor : 0;
    applied.alphaFloor = floorU.value;
  }
  if (profile.alphaRadius !== undefined) {
    // The uniform exists only once the patch has gone in, so a `false` before any patch is
    // simply "do nothing" rather than a state to record.
    if (profile.alphaRadius) applied.alphaRadius = !!spark.material?.uniforms?.dxrAlphaRadius;
    else if (spark.material?.uniforms?.dxrAlphaRadius) {
      spark.material.uniforms.dxrAlphaRadius.value = false;
      applied.alphaRadius = false;
    }
  }
  return applied;
}

/**
 * The half of a perf profile that has to go into the `SplatMesh` CONSTRUCTOR rather than onto the
 * renderer — Spark builds level-of-detail data at load time or not at all.
 *
 * LOD is the splat-COUNT axis: Spark keeps a merged, decimated pyramid and picks a level against
 * a budget (2.5M splats on desktop, 1M on Android) and a minimum on-screen splat size. It is
 * genuinely lossy — it substitutes merged splats — and it is inert unless the mesh was loaded
 * with it, which is why it cannot be switched on later from `applySplatPerf`.
 *
 * @param {object} perf
 * @returns {object} extra SplatMesh options (empty when LOD was not asked for).
 */
export function splatPerfMeshOptions(perf) {
  const profile =
    perf === true
      ? SPLAT_PERF_PRESETS.balanced
      : typeof perf === 'string'
        ? SPLAT_PERF_PRESETS[perf]
        : perf;
  if (!profile || !profile.lod) return {};
  return { lod: profile.lod === 'quality' ? 'quality' : true };
}

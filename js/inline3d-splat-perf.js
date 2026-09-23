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
 * Presets — chosen from measurements on this exact asset class, not from first principles.
 *
 * What the measurement said (1.18M-gaussian SHARP capture, M1 Pro, Chrome/ANGLE-Metal, GPU timer
 * queries, configs interleaved PER FRAME so clock drift cannot bias one against another; full
 * table in docs/authoring-inline-3d.md):
 *
 *   - **Splat COUNT is not the cost.** 50 % and 25 % decimations of the same scene measured
 *     within noise of the full one (+5 %, +1 % at 1920×1080). Decimation drops the small
 *     gaussians; the few enormous ones that cover the frame survive it, and they are the bill.
 *     A decimated asset is a download and memory win, not a render-cost win.
 *   - **Quad extent is the cost.** `maxStdDev` √8→√6 is −5…−20 % and √8→√4 is −22 %.
 *   - **The bit-exact `alphaRadius` buys ~nothing HERE**, because it has nothing to shrink: 86 %
 *     of this asset's gaussians are near-opaque (mean peak alpha 0.86; Spark doubles the stored
 *     alpha on top), and an opaque splat's own 1/255 radius is 3.53σ, wider than the √8 ≈ 2.83σ
 *     it is already drawn at. It stays available and stays exact — a scene of large, low-alpha
 *     haze is exactly where it pays, and that is the scene the native renderer was tuned on.
 *
 * So the presets are honest about which axis works, and nothing is applied unless a caller asks:
 * `addSplat` with no `perf` leaves every Spark default exactly where Spark put it.
 */
export const SPLAT_PERF_PRESETS = {
  /**
   * The bit-exact one. No measurable win on a mostly-opaque capture; real on a scene whose cost is
   * large low-alpha splats. Costs a little vertex ALU, so on a scene with nothing to shrink it can
   * read as a wash or a shade slower.
   */
  exact: {
    alphaRadius: true,
    minAlpha: ALPHA_FLOOR,
  },
  /** −5…−20 % measured. Truncates every splat's tail at 2.45σ instead of 2.83σ. */
  balanced: {
    minAlpha: ALPHA_FLOOR,
    maxStdDev: Math.sqrt(6),
  },
  /** −22 % measured. 2σ, plus the sub-pixel cull. For a phone, not for a hero. */
  aggressive: {
    minAlpha: ALPHA_FLOOR,
    maxStdDev: 2,
    // Both eigenaxes under a pixel. On the reference capture at 1280×720 and 1920×1080 this
    // changed ZERO channel bytes — a quad that small usually covers no sample point at all — but
    // it is framing-dependent by nature, so it is here and not in `balanced`.
    minPixelRadius: 1,
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
  // `alphaFloor` is meaningless on its own — it is the floor the shrink cuts at — so asking for
  // one asks for the shrink, unless the caller said otherwise in the same breath.
  const wantRadius = profile.alphaRadius ?? (profile.alphaFloor !== undefined ? true : undefined);
  if (wantRadius) patchAlphaRadius(spark.material);
  const u = spark.material?.uniforms;
  if (u?.dxrAlphaRadius && wantRadius !== undefined) {
    // Set the value every time rather than relying on the patch: the patch is idempotent, so a
    // second call asking to turn it back ON would otherwise return early and leave it off.
    u.dxrAlphaRadius.value = !!wantRadius;
    applied.alphaRadius = !!wantRadius;
  }
  if (u?.dxrAlphaFloor && profile.alphaFloor !== undefined) {
    u.dxrAlphaFloor.value = Number.isFinite(profile.alphaFloor) ? profile.alphaFloor : 0;
    applied.alphaFloor = u.dxrAlphaFloor.value;
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

// ── the same presets on the PlayCanvas engine (`addSplat(…, { engine: 'playcanvas' })`) ──────
//
// Same contract as the Spark half above: nothing moves unless asked, and every knob can be
// switched off. The presets are Spark-shaped (they were measured on Spark), so this maps each
// knob onto the engine's nearest equivalent rather than inventing engine presets:
//
// | Spark knob | engine (2.22.3) | note |
// |---|---|---|
// | `alphaRadius` | always on | the engine ALREADY shrinks every quad to its own alpha radius (`clipCorner` in `gsplatCommonVS`: `min(1, sqrt(ln(a / alphaClip)) / 2)` of the √8σ quad — the same cut `patchAlphaRadius` puts into Spark). It cannot be turned off, so `alphaRadius: false` is reported as `'native'`. |
// | `minAlpha` | `scene.gsplat.alphaClipForward` | engine default is already 1/255 |
// | `maxStdDev` | chunk override of `gsplatCommonVS` | the engine's quad is a fixed √8σ; the override caps `clipCorner`'s scale at `maxStdDev/√8`, which truncates both the quad AND the gaussian's uv, i.e. Spark's semantics. Only ever SHRINKS (≤ √8σ). |
// | `minPixelRadius` | `scene.gsplat.minPixelSize` = 2 × radius | the engine compares a quad DIAMETER in px (`max(l1,l2)`) |
// | `lod`, `lodSplat*`, `maxPixelRadius`, `falloff`, `alphaFloor` | none | Spark-only; ignored with one warning. The engine's splat-count lever is `splatBudget` (below) |
//
// Engine-native keys may be passed in an options object as well and win over the mapping:
// `alphaClipForward`, `minPixelSize`, `splatBudget` (a global splat count, per app = per tile),
// `antiAlias` (only for AA-trained assets).
//
// `minPixelSize` IS THE ONE DEFAULT CHANGED. The engine drops every splat whose quad is under
// 2 px by default; Spark keeps them (its `minPixelRadius` default is 0). On a lifted photograph
// the sub-2px grain is real texture, so every `perf` value except `false` starts from 0 — the
// Spark-parity baseline — and only a preset or option that states a size moves it. `perf: false`
// is the kill switch: the engine's own defaults, untouched, 2 px included.

/** The engine's quad half-extent, in σ: `l = 2·sqrt(2λ)` over cornerUV ∈ [-1,1] (gsplatCorner). */
export const PLAYCANVAS_QUAD_SIGMA = Math.sqrt(8);

/** Knobs that are engine-native and pass straight through to `app.scene.gsplat`. */
const PC_NATIVE = ['alphaClipForward', 'minPixelSize', 'splatBudget'];

/** Spark knobs with no engine equivalent — named once in a warning, then ignored. */
const PC_UNMAPPED = ['lod', 'lodSplatCount', 'lodSplatScale', 'lodRenderScale', 'maxPixelRadius', 'falloff', 'alphaFloor'];

/**
 * Resolve `perf` into engine settings. Pure: no engine, no GPU — the adapter applies the result.
 *
 * @param {undefined|null|false|true|string|object} perf  the `addSplat` option, as given.
 * @returns {{settings:object, quadExtent:number|null, applied:object|null, ignored:string[]}}
 *          `settings` go onto `app.scene.gsplat`; `quadExtent` (a fraction of the √8σ quad, or
 *          null for untouched) goes into the `gsplatCommonVS` override; `applied` is what the
 *          handle reports (null for `perf: false`).
 */
export function playcanvasPerfSettings(perf) {
  const out = { settings: {}, quadExtent: null, applied: null, ignored: [] };
  if (perf === false) return out; // kill switch: engine defaults, untouched

  let profile = null;
  let name = null;
  if (perf === undefined || perf === null) name = 'default';
  else if (perf === true) {
    profile = SPLAT_PERF_PRESETS.balanced;
    name = 'balanced';
  } else if (typeof perf === 'string') {
    profile = SPLAT_PERF_PRESETS[perf] || null;
    name = profile ? perf : 'default';
    if (!profile) {
      console.warn(
        `[inline3d/splat] unknown perf preset "${perf}" — ignored. ` +
          `Known: ${Object.keys(SPLAT_PERF_PRESETS).join(', ')}, or an options object.`,
      );
    }
  } else if (typeof perf === 'object') {
    profile = perf;
    name = 'custom';
  }

  const s = out.settings;
  const applied = { preset: name };
  // The Spark-parity baseline. See the block comment above.
  s.minPixelSize = 0;
  if (profile) {
    if (isNum(profile.minAlpha)) s.alphaClipForward = profile.minAlpha;
    if (isNum(profile.minPixelRadius)) s.minPixelSize = 2 * Math.max(0, profile.minPixelRadius);
    if (isNum(profile.maxStdDev) && profile.maxStdDev > 0) {
      const k = Math.min(1, profile.maxStdDev / PLAYCANVAS_QUAD_SIGMA);
      if (k < 1) out.quadExtent = k;
    }
    if (profile.alphaRadius !== undefined) applied.alphaRadius = 'native';
    for (const key of PC_NATIVE) if (isNum(profile[key])) s[key] = profile[key];
    if (typeof profile.antiAlias === 'boolean') s.antiAlias = profile.antiAlias;
    for (const key of PC_UNMAPPED) if (profile[key] !== undefined) out.ignored.push(key);
    if (out.ignored.length) {
      console.warn(
        `[inline3d/splat] perf: ${out.ignored.join(', ')} ${out.ignored.length > 1 ? 'have' : 'has'} ` +
          'no PlayCanvas equivalent and ' +
          `${out.ignored.length > 1 ? 'are' : 'is'} ignored on engine:'playcanvas' — the engine's ` +
          'splat-count lever is `splatBudget` (see js/inline3d-splat-perf.js).',
      );
    }
  }
  Object.assign(applied, s);
  if (out.quadExtent !== null) applied.maxStdDev = out.quadExtent * PLAYCANVAS_QUAD_SIGMA;
  out.applied = applied;
  return out;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// The anchor the quad-extent override rewrites, from the engine's `gsplatCommonVS` (2.22.3). The
// npm build re-indents chunks with tabs and a later release may re-space them, so it is a
// whitespace-agnostic regex, not a string.
const PC_CLIP_ANCHOR = /float\s+clip\s*=\s*min\(\s*1\.0\s*,/;

/**
 * Cap the engine's per-splat quad at `k` of its √8σ extent — Spark's `maxStdDev`, on PlayCanvas.
 *
 * Rewrites `clipCorner`'s `min(1.0, …)` to `min(k, …)`, which scales the corner offset AND the uv
 * the fragment shader evaluates the gaussian at, so the tail is truncated rather than the
 * profile squashed. Returns the source unchanged (and `ok:false`) when the anchor is missing;
 * the caller warns once and renders at the engine's own extent.
 *
 * @param {string} src  the current `gsplatCommonVS` chunk.
 * @param {number} k  in (0, 1).
 * @returns {{src:string, ok:boolean}}
 */
export function patchPlayCanvasQuadExtent(src, k) {
  if (typeof src !== 'string' || !(k > 0 && k < 1)) return { src, ok: false };
  if (src.includes('dxrQuadExtent')) return { src, ok: true }; // idempotent
  if (!PC_CLIP_ANCHOR.test(src)) return { src, ok: false };
  const lit = k.toFixed(7);
  return {
    src: src.replace(PC_CLIP_ANCHOR, `float clip = min(${lit} /* dxrQuadExtent */,`),
    ok: true,
  };
}

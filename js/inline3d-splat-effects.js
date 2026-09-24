// inline3d-splat-effects.js — shader effects for the PlayCanvas splat backend (`./splat`,
// `engine: 'playcanvas'`).
//
// PREVIEW TIER (see docs/sdk-stability.md). Internal module: pages reach it through the splat
// handle (`reveal`, `playEffect`, `setEffect`, `stopEffect`, `effects`, `setSource`'s
// `transition`), never by importing this file. Guide: docs/splat-effects.md.
//
// ── The two engine hooks (PlayCanvas 2.22.3) ──────────────────────────────────────────────────
//
//   TILE    `app.scene.gsplat.material`'s `gsplatModifyVS` chunk: the unified renderer's render-
//           time vertex stage, run for EVERY splat of the tile, every view, every frame. Cheap
//           (no work-buffer re-render), and what the engine's own reveal scripts use.
//   ENTITY  `entity.gsplat.setWorkBufferModifier` + `setParameter`: runs when the engine copies
//           ONE asset into the tile's work buffer. The only hook that can tell two assets apart
//           (setSource's incoming vs outgoing). While one is installed the work buffer is re-
//           rendered every frame (WORKBUFFER_UPDATE_ALWAYS); measured within noise on a 1.18M
//           photo. Here `splat.index` is the asset's own FILE index (entity scope only).
//
// Both take the same three functions — modifySplatCenter / modifySplatRotationScale /
// modifySplatColor — on WORLD-space centres (the engine world = this adapter's content space).
//
// ── One generated chunk per hook ──────────────────────────────────────────────────────────────
//
// The SDK owns the chunk: every active effect of a scope is ONE function body with its own
// uniform prefix, and the chunk calls them in a FIXED order, STAGE_ORDER: grade → clip → reveal →
// pulse → custom. Removing the last effect deletes the chunk (tile) or the modifier (entity),
// which restores the engine's own default — the exact baseline, not a no-op look-alike.
//
// Adding an effect = one GLSL body + one registry entry in EFFECTS below: `glsl(P)` defines
// `P##center`, `P##rs`, `P##color`, and `uniforms(ctx, inst, amount)` returns the values.
//
// ── The stereo rule ───────────────────────────────────────────────────────────────────────────
//
// Every effect is keyed on WORLD position and TIME only. Each eye of a woven tile renders the
// same splats; a decision keyed on a screen position would differ between the eyes and read as
// rivalry. So no effect here reads gl_FragCoord or a view matrix, and the custom hook exposes no
// screen-space input. (The one image-space piece, setSource's frame snapshot, lives in the
// adapter and samples each eye's own half at the zero-disparity plane.)
//
// ── Sort caveat ───────────────────────────────────────────────────────────────────────────────
//
// The engine sorts by the ORIGINAL centres. Effects that keep each splat on its own ray (inflate,
// the wavefront ridge) or only hide/show splats (sweep, fade, dissolve's reveal) keep a valid
// order; a custom effect that moves splats far will blend slightly out of order while in flight.

import { coverageExponent, FADE_TRANSMITTANCE_FLOOR } from './inline3d-splat-shared.js';

/** The fixed composition order of a generated chunk. */
export const STAGE_ORDER = Object.freeze(['grade', 'clip', 'reveal', 'pulse', 'custom']);

/** Named easings (a function `(x) => y` on [0, 1] is accepted too). */
export const EASINGS = Object.freeze({
  linear: (x) => x,
  easeInQuad: (x) => x * x,
  easeOutQuad: (x) => 1 - (1 - x) * (1 - x),
  easeInOutQuad: (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2),
  easeInCubic: (x) => x * x * x,
  easeOutCubic: (x) => 1 - Math.pow(1 - x, 3),
  easeInOutCubic: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  easeInOutSine: (x) => -(Math.cos(Math.PI * x) - 1) / 2,
});

/** The optical depth the `fade` effect ramps for (docs/splat-effects.md §fade, measured). */
export const FADE_EFFECT_OPTICAL_DEPTH = 24;

// Shared GLSL, emitted once per chunk.
//
// dxrFxHash / dxrFxNoise / dxrFxFbm: adapted from PlayCanvas engine
// scripts/esm/gsplat/shader-effect-dissolve.mjs @ v2.22.3, MIT (THIRD_PARTY_NOTICES.md).
const PRELUDE = `
float dxrFxHash(vec3 p) {
  p = fract(p * vec3(443.8975, 397.2973, 491.1871));
  p += dot(p, p.yzx + 19.19);
  return fract((p.x + p.y) * p.z);
}
float dxrFxNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(dxrFxHash(i + vec3(0.0, 0.0, 0.0)), dxrFxHash(i + vec3(1.0, 0.0, 0.0)), u.x),
        mix(dxrFxHash(i + vec3(0.0, 1.0, 0.0)), dxrFxHash(i + vec3(1.0, 1.0, 0.0)), u.x), u.y),
    mix(mix(dxrFxHash(i + vec3(0.0, 0.0, 1.0)), dxrFxHash(i + vec3(1.0, 0.0, 1.0)), u.x),
        mix(dxrFxHash(i + vec3(0.0, 1.0, 1.0)), dxrFxHash(i + vec3(1.0, 1.0, 1.0)), u.x), u.y),
    u.z);
}
float dxrFxFbm(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 3; i++) {
    sum += amp * dxrFxNoise(p);
    p *= 2.02;
    amp *= 0.5;
  }
  return sum / 0.875;
}
`;

const vec3Of = (v, what) => {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite)) {
    throw new TypeError(`@displayxr/inline3d/splat: ${what} must be [x, y, z] (finite numbers).`);
  }
  return [v[0], v[1], v[2]];
};
const num = (v, what, lo = -Infinity, hi = Infinity) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) {
    throw new RangeError(`@displayxr/inline3d/splat: ${what} must be a number in [${lo}, ${hi}], got ${v}.`);
  }
  return v;
};

/** Distance from `c` to the farthest corner of a {center, extent} box. */
function farthestCorner(c, box) {
  if (!box) return 1;
  let m = 0;
  for (const sx of [-0.5, 0.5]) for (const sy of [-0.5, 0.5]) for (const sz of [-0.5, 0.5]) {
    const x = box.center[0] + sx * box.extent[0] - c[0];
    const y = box.center[1] + sy * box.extent[1] - c[1];
    const z = box.center[2] + sz * box.extent[2] - c[2];
    m = Math.max(m, Math.hypot(x, y, z));
  }
  return m > 0 ? m : 1;
}
const maxExtent = (box) => (box ? Math.max(box.extent[0], box.extent[1], box.extent[2], 1e-6) : 1);

// ── the registry ──────────────────────────────────────────────────────────────────────────────
//
// kind 'transition': played over time (playEffect / reveal), direction 'in' (the asset arrives:
//   the effect goes from its start state to the untouched asset, then is REMOVED) or 'out' (the
//   asset leaves: from untouched to the end state, which is HELD until stopEffect). The GLSL
//   gets `amount` = how much of the untouched asset shows (1 = untouched; every body returns
//   early at 1, so amount 1 is the baseline exactly).
// kind 'persistent': setEffect only, no clock (grade, clip).
// kind 'pulse': played; a one-off overlay that is removed at the end.

/** @type {Record<string, object>} */
export const EFFECTS = {
  // The gallery's Spatial View reveal: z' = D + (z − D)·s along rays from the centre of projection
  // O (the eyes' midpoint by default — invisible from there, so the eyes see DISPARITY arrive, not
  // a zoom), centre AND scale scaled by the same λ (footprint fixed from O). s eases from
  // `residual` (0.05: a perfectly flat cloud loses its depth ORDER) to 1.
  inflate: {
    stage: 'reveal',
    kind: 'transition',
    defaults: { durationMs: 1200, easing: 'easeOutCubic', holdMs: 0, origin: 'eyes', direction: 'in', residual: 0.05 },
    validate: (o) => {
      if (o.residual !== undefined) num(o.residual, 'inflate residual', 0, 1);
    },
    glsl: (P) => `
uniform float ${P}amount;
uniform float ${P}s0;
uniform vec3 ${P}O;
uniform vec3 ${P}A;
uniform float ${P}D;
float ${P}lambda;
void ${P}center(inout vec3 c) {
  ${P}lambda = 1.0;
  if (${P}amount >= 1.0) return;
  float s = mix(${P}s0, 1.0, ${P}amount);
  vec3 v = c - ${P}O;
  float d = dot(v, ${P}A);
  if (d <= 1e-4) return;
  ${P}lambda = (${P}D + (d - ${P}D) * s) / d;
  c = ${P}O + v * ${P}lambda;
}
void ${P}rs(vec3 oc, vec3 mc, inout vec4 r, inout vec3 sc) { sc *= ${P}lambda; }
void ${P}color(vec3 c, inout vec4 col) {}
`,
    uniforms: (ctx, inst, amount) => {
      const eyes = ctx.eyes();
      const O = inst.originPoint(ctx, eyes);
      const A = eyes.axis;
      const f = ctx.focus();
      let D = (f[0] - O[0]) * A[0] + (f[1] - O[1]) * A[1] + (f[2] - O[2]) * A[2];
      if (!(D > 1e-4)) D = 1;
      return { amount, s0: inst.opts.residual, O, A, D };
    },
  },

  // A radial dissolve-in from a world point: a jittered sphere front whose radius reaches the
  // farthest corner of the FRAMING box (the percentile box the camera frames, not the file's raw
  // bound — one outlier would otherwise slow the whole sweep). Splats inside grow from dots, with
  // a tinted band at the front. Hides/shows only: no splat moves.
  sweep: {
    stage: 'reveal',
    kind: 'transition',
    defaults: { durationMs: 1500, easing: 'easeInQuad', holdMs: 0, origin: 'focus', direction: 'in', band: 0.1, edgeColor: [0.2, 0.9, 1.0], edge: 0.6 },
    validate: (o) => {
      if (o.band !== undefined) num(o.band, 'sweep band', 1e-4, 1);
      if (o.edge !== undefined) num(o.edge, 'sweep edge', 0, 4);
      if (o.edgeColor !== undefined) vec3Of(o.edgeColor, 'sweep edgeColor');
    },
    glsl: (P) => `
uniform float ${P}amount;
uniform vec3 ${P}C;
uniform float ${P}R;
uniform float ${P}B;
uniform vec3 ${P}E;
float ${P}k(vec3 c) {
  float j = (dxrFxHash(c) - 0.5) * ${P}B;
  return clamp((${P}R - length(c - ${P}C) + j) / ${P}B, 0.0, 1.0);
}
void ${P}center(inout vec3 c) {}
void ${P}rs(vec3 oc, vec3 mc, inout vec4 r, inout vec3 sc) {
  if (${P}amount >= 1.0) return;
  float k = ${P}k(oc);
  if (k <= 0.0) { sc = vec3(0.0); return; }
  sc *= mix(0.15, 1.0, k * k);
}
void ${P}color(vec3 c, inout vec4 col) {
  if (${P}amount >= 1.0) return;
  float k = ${P}k(c);
  if (k <= 0.0) { col.a = 0.0; return; }
  col.rgb += ${P}E * (1.0 - k);
}
`,
    start: (ctx, inst) => {
      const C = inst.originPoint(ctx);
      const far = farthestCorner(C, ctx.framing());
      inst.state.band = inst.opts.band * far;
      inst.state.far = far;
      inst.state.C = C;
    },
    // The front starts one band BEFORE the origin (amount 0 shows nothing, jitter included) and
    // ends past the farthest framed corner.
    uniforms: (ctx, inst, amount) => ({
      amount,
      C: inst.state.C,
      R: -inst.state.band + amount * (inst.state.far + 2.5 * inst.state.band),
      B: inst.state.band,
      E: inst.opts.edgeColor.map((x) => x * inst.opts.edge),
    }),
  },

  // Coverage-linear opacity: α' = 1 − (1 − α)^k with k = coverageExponent(amount). Plain α·t
  // saturates on a dense photo (a pixel under many near-opaque splats is covered long before t
  // reaches 1).
  fade: {
    stage: 'reveal',
    kind: 'transition',
    defaults: { durationMs: 800, easing: 'linear', holdMs: 0, origin: 'focus', direction: 'in' },
    glsl: (P) => `
uniform float ${P}amount;
uniform float ${P}k;
void ${P}center(inout vec3 c) {}
void ${P}rs(vec3 oc, vec3 mc, inout vec4 r, inout vec3 sc) {}
void ${P}color(vec3 c, inout vec4 col) {
  if (${P}amount >= 1.0) return;
  col.a = ${P}k <= 0.0 ? 0.0 : 1.0 - pow(max(1.0 - col.a, ${FADE_TRANSMITTANCE_FLOOR.toFixed(4)}), ${P}k);
}
`,
    uniforms: (ctx, inst, amount) => ({ amount, k: coverageExponent(amount, FADE_EFFECT_OPTICAL_DEPTH) }),
  },

  // The engine's dissolve, as a reveal: splats burn in along an fbm noise front — lifted along
  // the camera's UP (never toward the viewer), swaying, glowing at the edge. Sizes follow the
  // framing box, so the look is the same on a 2 cm object and a 40 m street.
  //
  // Adapted from PlayCanvas engine scripts/esm/gsplat/shader-effect-dissolve.mjs @ v2.22.3, MIT
  // (THIRD_PARTY_NOTICES.md): the burn/lift/sway/edge body; the crop and AABB gates are dropped
  // and the progress is inverted (amount 1 = intact).
  dissolve: {
    stage: 'reveal',
    kind: 'transition',
    defaults: { durationMs: 2000, easing: 'linear', holdMs: 0, origin: 'focus', direction: 'in', noiseScale: 3, edgeWidth: 0.12, edgeColor: [1.0, 0.45, 0.1], lift: 0.25, wave: 0.03 },
    validate: (o) => {
      if (o.noiseScale !== undefined) num(o.noiseScale, 'dissolve noiseScale', 1e-3, 1e3);
      if (o.edgeWidth !== undefined) num(o.edgeWidth, 'dissolve edgeWidth', 1e-3, 1);
      if (o.lift !== undefined) num(o.lift, 'dissolve lift', 0, 10);
      if (o.wave !== undefined) num(o.wave, 'dissolve wave', 0, 1);
      if (o.edgeColor !== undefined) vec3Of(o.edgeColor, 'dissolve edgeColor');
    },
    glsl: (P) => `
uniform float ${P}amount;
uniform float ${P}freq;
uniform float ${P}ew;
uniform vec3 ${P}ec;
uniform vec3 ${P}up;
uniform float ${P}lift;
uniform float ${P}wa;
uniform float ${P}wf;
uniform float ${P}time;
// The burn is keyed on the ORIGINAL centre and kept for the colour stage (as the engine's
// script does), so the lift cannot change which splats burn. -1 = not computed this splat (a
// colour-only work-buffer pass skips the centre stage): the colour stage then computes it.
float ${P}b = -1.0;
float ${P}burn(vec3 c, out float n) {
  n = dxrFxFbm(c * ${P}freq);
  return clamp(((1.0 - ${P}amount) * (1.0 + ${P}ew) - n) / ${P}ew, 0.0, 1.0);
}
void ${P}center(inout vec3 c) {
  ${P}b = -1.0;
  if (${P}amount >= 1.0) return;
  float n;
  float b = ${P}burn(c, n);
  ${P}b = b;
  if (b <= 0.0) return;
  float travel = b * b;
  vec3 off = ${P}up * (travel * ${P}lift);
  float phase = n * 43.7;
  off.x += sin(c.y * ${P}wf + phase + ${P}time * 2.0) * ${P}wa * travel;
  off.z += cos(c.x * ${P}wf + phase + ${P}time * 1.7) * ${P}wa * travel;
  c += off;
}
void ${P}rs(vec3 oc, vec3 mc, inout vec4 r, inout vec3 sc) {
  if (${P}amount >= 1.0) return;
  float n;
  float b = ${P}burn(oc, n);
  if (b <= 0.0) return;
  if (b >= 1.0) { sc = vec3(0.0); return; }
  float size = gsplatGetSizeFromScale(sc);
  sc = mix(sc, vec3(size), min(b * 3.0, 1.0));
  sc *= (1.0 - b);
}
void ${P}color(vec3 c, inout vec4 col) {
  if (${P}amount >= 1.0) return;
  float n;
  float b = ${P}b >= 0.0 ? ${P}b : ${P}burn(c, n);
  if (b <= 0.0) return;
  col.rgb = mix(col.rgb, ${P}ec, smoothstep(0.0, 0.4, b));
  col.a *= 1.0 - smoothstep(0.5, 1.0, b);
}
`,
    start: (ctx, inst) => {
      const ext = maxExtent(ctx.framing());
      inst.state.ext = ext;
      inst.state.up = ctx.eyes().up;
    },
    uniforms: (ctx, inst, amount, tMs) => ({
      amount,
      freq: inst.opts.noiseScale / inst.state.ext,
      ew: inst.opts.edgeWidth,
      ec: inst.opts.edgeColor,
      up: inst.state.up,
      lift: inst.opts.lift * inst.state.ext,
      wa: inst.opts.wave * inst.state.ext,
      wf: 6 / inst.state.ext,
      time: inst.elapsedS(tMs),
    }),
  },

  // A ring of light expanding from a world point and fading out. Colour only.
  pulse: {
    stage: 'pulse',
    kind: 'pulse',
    defaults: { durationMs: 1200, easing: 'easeOutQuad', holdMs: 0, origin: 'focus', color: [1, 1, 1], strength: 0.35, band: 0.06 },
    validate: (o) => {
      if (o.color !== undefined) vec3Of(o.color, 'pulse color');
      if (o.strength !== undefined) num(o.strength, 'pulse strength', 0, 4);
      if (o.band !== undefined) num(o.band, 'pulse band', 1e-4, 1);
      if (o.radius !== undefined) num(o.radius, 'pulse radius', 1e-6);
    },
    glsl: (P) => `
uniform vec3 ${P}C;
uniform float ${P}R;
uniform float ${P}B;
uniform vec3 ${P}K;
void ${P}center(inout vec3 c) {}
void ${P}rs(vec3 oc, vec3 mc, inout vec4 r, inout vec3 sc) {}
void ${P}color(vec3 c, inout vec4 col) {
  float x = (length(c - ${P}C) - ${P}R) / ${P}B;
  col.rgb += ${P}K * exp(-x * x);
}
`,
    start: (ctx, inst) => {
      const C = inst.originPoint(ctx);
      inst.state.C = C;
      // How far the ring travels, world units: `radius`, else the farthest framed corner.
      inst.state.R1 = inst.opts.radius ?? farthestCorner(C, ctx.framing());
    },
    uniforms: (ctx, inst, e) => ({
      C: inst.state.C,
      R: e * inst.state.R1,
      B: Math.max(1e-6, inst.opts.band * inst.state.R1),
      K: inst.opts.color.map((x) => x * inst.opts.strength * (1 - e)),
    }),
  },

  // Colour grade: exposure (stops), contrast about mid grey, saturation, a tint multiplier.
  grade: {
    stage: 'grade',
    kind: 'persistent',
    defaults: { exposure: 0, contrast: 1, saturation: 1, tint: [1, 1, 1] },
    validate: (o) => {
      if (o.exposure !== undefined) num(o.exposure, 'grade exposure', -10, 10);
      if (o.contrast !== undefined) num(o.contrast, 'grade contrast', 0, 10);
      if (o.saturation !== undefined) num(o.saturation, 'grade saturation', 0, 10);
      if (o.tint !== undefined) vec3Of(o.tint, 'grade tint');
    },
    glsl: (P) => `
uniform float ${P}gain;
uniform float ${P}contrast;
uniform float ${P}sat;
uniform vec3 ${P}tint;
void ${P}center(inout vec3 c) {}
void ${P}rs(vec3 oc, vec3 mc, inout vec4 r, inout vec3 sc) {}
void ${P}color(vec3 c, inout vec4 col) {
  vec3 rgb = col.rgb * ${P}gain;
  rgb = (rgb - 0.5) * ${P}contrast + 0.5;
  float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  col.rgb = mix(vec3(l), rgb, ${P}sat) * ${P}tint;
}
`,
    uniforms: (ctx, inst) => ({
      gain: Math.pow(2, inst.opts.exposure),
      contrast: inst.opts.contrast,
      sat: inst.opts.saturation,
      tint: inst.opts.tint,
    }),
  },

  // Clip to a box or a sphere, given in the splat's OWN (model) space like setFocus; `invert`
  // keeps the outside instead.
  clip: {
    stage: 'clip',
    kind: 'persistent',
    defaults: { invert: false },
    validate: (o) => {
      const has = (o.box ? 1 : 0) + (o.sphere ? 1 : 0);
      if (has !== 1) throw new TypeError("@displayxr/inline3d/splat: setEffect('clip') needs exactly one of { box: { min, max } } or { sphere: { center, radius } }.");
      if (o.box) {
        vec3Of(o.box.min, 'clip box.min');
        vec3Of(o.box.max, 'clip box.max');
      }
      if (o.sphere) {
        vec3Of(o.sphere.center, 'clip sphere.center');
        num(o.sphere.radius, 'clip sphere.radius', 0);
      }
    },
    glsl: (P) => `
uniform float ${P}mode;
uniform vec3 ${P}lo;
uniform vec3 ${P}hi;
uniform vec3 ${P}sc;
uniform float ${P}sr;
uniform float ${P}inv;
bool ${P}out(vec3 c) {
  bool inside = ${P}mode < 0.5
    ? all(greaterThanEqual(c, ${P}lo)) && all(lessThanEqual(c, ${P}hi))
    : length(c - ${P}sc) <= ${P}sr;
  return ${P}inv > 0.5 ? inside : !inside;
}
void ${P}center(inout vec3 c) {}
void ${P}rs(vec3 oc, vec3 mc, inout vec4 r, inout vec3 sc) { if (${P}out(oc)) sc = vec3(0.0); }
void ${P}color(vec3 c, inout vec4 col) { if (${P}out(c)) col.a = 0.0; }
`,
    uniforms: (ctx, inst) => {
      const o = inst.opts;
      if (o.box) {
        const a = ctx.modelToContent(o.box.min);
        const b = ctx.modelToContent(o.box.max);
        return {
          mode: 0,
          lo: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
          hi: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])],
          sc: [0, 0, 0],
          sr: 0,
          inv: o.invert ? 1 : 0,
        };
      }
      return { mode: 1, lo: [0, 0, 0], hi: [0, 0, 0], sc: ctx.modelToContent(o.sphere.center), sr: o.sphere.radius, inv: o.invert ? 1 : 0 };
    },
  },

  // setSource's wavefront transition, incoming side — the approved photo-frame transition
  // (PROPOSALS.md #1; the prototype's mode 3): a soft front crosses the picture left → right over
  // normalised u, `band` (0.18) of the travel wide; column u commits A → B over
  // lt = clamp((t − u·(1 − band)) / band, 0, 1) with a smoothstep. The image half of the commit
  // (the outgoing frame giving way) is the adapter's snapshot wipe, on the SAME lt. This half is
  // the depth RIDGE riding the front: sin(π·lt) × `ridge` world units (0.03 m on a metric photo)
  // toward the eyes, along each splat's own ray with its scale by the same λ — it keeps its place
  // and size in the picture and only comes forward. CAPPED so the extra disparity never exceeds
  // `ridgeMaxDisparity` of the eye view's width: Δ ≤ cap · 2·tan(fovX/2) · d² / eyeSeparation.
  // u is the splat's angle in the transition's fixed camera frame (x/z — for a photo, its grid
  // column), world position only, so both eyes agree.
  wavefront: {
    stage: 'reveal',
    kind: 'transition',
    internal: true,
    defaults: { durationMs: 2000, easing: 'easeInOutSine', holdMs: 0, origin: 'eyes', direction: 'in', band: 0.18, ridge: 0.03, ridgeMaxDisparity: 0.004 },
    validate: (o) => {
      if (o.band !== undefined) num(o.band, 'wavefront band', 0.01, 1);
      if (o.ridge !== undefined) num(o.ridge, 'wavefront ridge', 0, 1);
      if (o.ridgeMaxDisparity !== undefined) num(o.ridgeMaxDisparity, 'wavefront ridgeMaxDisparity', 0, 0.05);
    },
    glsl: (P) => `
uniform float ${P}amount;
uniform float ${P}band;
uniform float ${P}ridge;
uniform float ${P}capK;
uniform vec3 ${P}O;
uniform vec3 ${P}A;
uniform vec3 ${P}X;
uniform float ${P}tanX;
float ${P}lambda;
void ${P}center(inout vec3 c) {
  ${P}lambda = 1.0;
  if (${P}amount >= 1.0) return;
  vec3 v = c - ${P}O;
  float d = dot(v, ${P}A);
  if (d <= 1e-4) return;
  float u = 0.5 + 0.5 * dot(v, ${P}X) / (d * ${P}tanX);
  float lt = clamp((${P}amount - u * (1.0 - ${P}band)) / ${P}band, 0.0, 1.0);
  float bump = min(${P}ridge, ${P}capK * d * d) * sin(lt * 3.14159265);
  ${P}lambda = (d - bump) / d;
  c = ${P}O + v * ${P}lambda;
}
void ${P}rs(vec3 oc, vec3 mc, inout vec4 r, inout vec3 sc) { sc *= ${P}lambda; }
void ${P}color(vec3 c, inout vec4 col) {}
`,
    start: (ctx, inst) => {
      const eyes = ctx.eyes();
      inst.state.O = eyes.origin;
      inst.state.A = eyes.axis;
      inst.state.X = eyes.right;
      inst.state.tanX = eyes.tanHalfFovX > 0 ? eyes.tanHalfFovX : 0.5;
      // No eye separation (2D): no disparity to cap (the ridge moves along the camera's own rays).
      inst.state.capK = eyes.separation > 0 ? (inst.opts.ridgeMaxDisparity * 2 * inst.state.tanX) / eyes.separation : 1e9;
    },
    uniforms: (ctx, inst, amount) => ({
      amount,
      band: inst.opts.band,
      ridge: inst.opts.ridge,
      capK: inst.state.capK,
      O: inst.state.O,
      A: inst.state.A,
      X: inst.state.X,
      tanX: inst.state.tanX,
    }),
  },

  // Internal: setSource's crossfade FALLBACK (no frame snapshot) — the coverage remap on one
  // entity, driven by the adapter.
  xfade: {
    stage: 'reveal',
    kind: 'persistent',
    internal: true,
    defaults: { k: 1 },
    glsl: (P) => `
uniform float ${P}k;
void ${P}center(inout vec3 c) {}
void ${P}rs(vec3 oc, vec3 mc, inout vec4 r, inout vec3 sc) {}
void ${P}color(vec3 c, inout vec4 col) {
  if (${P}k >= 1.0) return;
  col.a = ${P}k <= 0.0 ? 0.0 : 1.0 - pow(max(1.0 - col.a, ${FADE_TRANSMITTANCE_FLOOR.toFixed(4)}), ${P}k);
}
`,
    uniforms: (ctx, inst) => ({ k: inst.opts.k }),
  },
};
// `deflate` = inflate, out: the photo flattens onto its convergence plane (zero disparity) and
// stays flat until stopEffect.
EFFECTS.deflate = { ...EFFECTS.inflate, defaults: { ...EFFECTS.inflate.defaults, direction: 'out', easing: 'easeInOutSine' } };

/**
 * The wavefront's per-column commit, lt ∈ [0, 1], for eased progress `t` at normalised u — the
 * prototype's formula: column u starts at t = u·(1 − band) and has committed band later, so
 * u = 0 starts at t = 0 and u = 1 finishes at t = 1. The adapter's snapshot wipe and the ridge
 * both use it.
 */
export function wavefrontCommit(t, u, band) {
  return Math.min(1, Math.max(0, (t - u * (1 - band)) / band));
}

/** Names a page may pass to playEffect / setEffect / reveal. */
export const PUBLIC_EFFECTS = Object.freeze(
  Object.keys(EFFECTS)
    .filter((n) => !EFFECTS[n].internal)
    .concat(['custom'])
    .sort(),
);
/** addSplat's `reveal` accepts these (the transition effects). */
export const REVEAL_EFFECTS = Object.freeze(['inflate', 'sweep', 'dissolve', 'fade']);

// ── custom GLSL ───────────────────────────────────────────────────────────────────────────────

const HOOK_FNS = [
  ['modifySplatCenter', 'center', 'void %(inout vec3 c) {}'],
  ['modifySplatRotationScale', 'rs', 'void %(vec3 oc, vec3 mc, inout vec4 r, inout vec3 sc) {}'],
  ['modifySplatColor', 'color', 'void %(vec3 c, inout vec4 col) {}'],
];

/** Screen-space inputs a custom body may not read (the stereo rule). */
const SCREEN_SPACE = /\b(gl_FragCoord|gl_Position|matrix_view|matrix_projection|matrix_viewProjection|viewport_size|view_position|uCameraPosition)\b/;

/**
 * A custom effect's body under prefix P: the engine-shaped functions renamed to P##center/rs/
 * color (missing ones stubbed), with `dxrProgress` and `dxrTime` defined for it.
 */
export function customGlsl(P, glsl) {
  let body = String(glsl);
  let out = `uniform float ${P}p;\nuniform float ${P}t;\n#define dxrProgress ${P}p\n#define dxrTime ${P}t\n`;
  for (const [engineName, suffix, stub] of HOOK_FNS) {
    const re = new RegExp(`\\b${engineName}\\b`, 'g');
    if (re.test(body)) body = body.replace(re, `${P}${suffix}`);
    else out += stub.replace('%', `${P}${suffix}`) + '\n';
  }
  return out + body + '\n#undef dxrProgress\n#undef dxrTime\n';
}

function validateCustom(o) {
  if (typeof o.glsl !== 'string' || !o.glsl.trim()) {
    throw new TypeError("@displayxr/inline3d/splat: the custom effect needs { glsl: '…' } — engine-shaped modifySplatCenter / modifySplatRotationScale / modifySplatColor bodies (docs/splat-effects.md §custom).");
  }
  for (const [k, s] of [['glsl', o.glsl], ['fragmentGlsl', o.fragmentGlsl]]) {
    if (s !== undefined && typeof s !== 'string') throw new TypeError(`@displayxr/inline3d/splat: custom ${k} must be a string.`);
    if (typeof s === 'string' && SCREEN_SPACE.test(s)) {
      throw new Error(
        `@displayxr/inline3d/splat: custom ${k} reads a screen-space input (${s.match(SCREEN_SPACE)[1]}). Effects are keyed on ` +
          'world position and time only — a screen-keyed decision differs between the two eyes of a woven tile.',
      );
    }
  }
  if (o.fragmentGlsl !== undefined && o.scope === 'entity') {
    throw new Error("@displayxr/inline3d/splat: custom fragmentGlsl is tile scope only (the work buffer has no fragment stage).");
  }
  if (o.uniforms !== undefined) {
    if (!o.uniforms || typeof o.uniforms !== 'object') throw new TypeError('@displayxr/inline3d/splat: custom uniforms must be an object.');
    for (const [k, v] of Object.entries(o.uniforms)) {
      if (!/^[A-Za-z_]\w*$/.test(k) || k.startsWith('gl_') || k.startsWith('dxr')) {
        throw new Error(`@displayxr/inline3d/splat: custom uniform name '${k}' is not allowed (a GLSL identifier, not gl_* or dxr*).`);
      }
      const ok = typeof v === 'function' || (typeof v === 'number' && Number.isFinite(v)) || (Array.isArray(v) && v.length >= 1 && v.length <= 4 && v.every(Number.isFinite));
      if (!ok) throw new TypeError(`@displayxr/inline3d/splat: custom uniform '${k}' must be a number, a 1–4 number array, or (tMs) => value.`);
    }
  }
}

// ── option validation ─────────────────────────────────────────────────────────────────────────

const isCustom = (name) => name === 'custom' || (typeof name === 'string' && name.startsWith('custom:') && name.length > 7);
const defOf = (name) => (isCustom(name) ? CUSTOM_DEF : EFFECTS[name]);

const CUSTOM_DEF = {
  stage: 'custom',
  kind: 'custom',
  defaults: { durationMs: 1000, easing: 'linear', holdMs: 0, scope: 'tile' },
};

/**
 * Validate + default one effect call. `mode` is 'play' | 'set'. Throws on anything a page could
 * not have meant (an unknown name, an effect in the wrong call, a bad number).
 */
export function resolveEffectOptions(name, opts = {}, mode = 'play', { internal = false } = {}) {
  const def = defOf(name);
  if (!def || (def.internal && !internal)) {
    throw new Error(`@displayxr/inline3d/splat: unknown effect '${name}'. Known: ${PUBLIC_EFFECTS.join(', ')} (and 'custom:<name>').`);
  }
  if (opts === null || typeof opts !== 'object') throw new TypeError(`@displayxr/inline3d/splat: ${name} options must be an object.`);
  if (mode === 'play' && def.kind === 'persistent') {
    throw new Error(`@displayxr/inline3d/splat: '${name}' is a persistent effect — use setEffect('${name}', params), not playEffect.`);
  }
  const o = { ...def.defaults, ...opts };
  if (o.durationMs !== undefined) num(o.durationMs, `${name} durationMs`, 0, 600000);
  if (o.holdMs !== undefined) num(o.holdMs, `${name} holdMs`, 0, 600000);
  if (o.easing !== undefined && typeof o.easing !== 'function' && !EASINGS[o.easing]) {
    throw new Error(`@displayxr/inline3d/splat: unknown easing '${o.easing}'. Known: ${Object.keys(EASINGS).join(', ')}, or a function.`);
  }
  if (o.direction !== undefined && o.direction !== 'in' && o.direction !== 'out') {
    throw new Error(`@displayxr/inline3d/splat: ${name} direction must be 'in' or 'out'.`);
  }
  if (o.scope !== undefined && o.scope !== 'tile' && o.scope !== 'entity') {
    throw new Error(`@displayxr/inline3d/splat: ${name} scope must be 'tile' or 'entity'.`);
  }
  if (o.progress !== undefined) num(o.progress, `${name} progress`, 0, 1);
  if (o.origin !== undefined) o.origin = resolveOriginSpec(o.origin, name);
  if (isCustom(name)) validateCustom(o);
  else def.validate?.(o);
  if (typeof o.easing === 'string') o.easingFn = EASINGS[o.easing];
  else if (typeof o.easing === 'function') o.easingFn = o.easing;
  return o;
}

/**
 * Origins: 'focus' (the focus point, the default for sweep/dissolve/pulse), 'eyes' (the eyes'
 * midpoint, the inflate default), [x, y, z] in the splat's own space, or a 2-D point on the
 * canvas — [clientX, clientY] or { clientX, clientY } — turned into a world point with pick()
 * when the effect starts.
 */
export function resolveOriginSpec(origin, name = 'effect') {
  if (origin === 'focus' || origin === 'eyes') return { kind: origin };
  if (Array.isArray(origin) && origin.length === 3 && origin.every(Number.isFinite)) return { kind: 'model', point: origin.slice() };
  if (Array.isArray(origin) && origin.length === 2 && origin.every(Number.isFinite)) return { kind: 'client', x: origin[0], y: origin[1] };
  if (origin && typeof origin === 'object' && Number.isFinite(origin.clientX) && Number.isFinite(origin.clientY)) {
    return { kind: 'client', x: origin.clientX, y: origin.clientY };
  }
  if (origin && typeof origin === 'object' && 'kind' in origin) return origin; // already resolved
  throw new TypeError(
    `@displayxr/inline3d/splat: ${name} origin must be 'focus', 'eyes', [x, y, z] (the splat's own space) or a canvas point [clientX, clientY].`,
  );
}

// ── composition ───────────────────────────────────────────────────────────────────────────────

const slug = (name) => name.replace(/[^A-Za-z0-9]/g, '_');

/** Uniform prefix of an effect instance. */
export const prefixOf = (name) => `dxrFx_${slug(name)}_`;

/**
 * THE generated modifier: `instances` = [{ name, def, opts }] of one scope, emitted in
 * STAGE_ORDER (ties keep insertion order). Pure — test/splat-effects.test.mjs pins it.
 */
export function composeModifier(instances) {
  const list = instances
    .map((inst, i) => ({ inst, i, s: STAGE_ORDER.indexOf(inst.def.stage) }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.inst);
  let code = '// generated by @displayxr/inline3d/splat (splat effects)\n' + PRELUDE;
  const calls = { center: [], rs: [], color: [] };
  for (const inst of list) {
    const P = prefixOf(inst.name);
    code += `// ── ${inst.name} (${inst.def.stage})\n`;
    code += isCustom(inst.name) ? customGlsl(P, inst.opts.glsl) : inst.def.glsl(P);
    calls.center.push(`  ${P}center(center);`);
    calls.rs.push(`  ${P}rs(originalCenter, modifiedCenter, rotation, scale);`);
    calls.color.push(`  ${P}color(center, color);`);
  }
  code += `void modifySplatCenter(inout vec3 center) {\n${calls.center.join('\n')}\n}\n`;
  code += `void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {\n${calls.rs.join('\n')}\n}\n`;
  code += `void modifySplatColor(vec3 center, inout vec4 color) {\n${calls.color.join('\n')}\n}\n`;
  return { code, order: list.map((i) => i.name) };
}

// ── the runner ────────────────────────────────────────────────────────────────────────────────

/**
 * One tile's effects. The adapter owns one and drives `tick(tMs)` once per frame, before the
 * engine renders.
 *
 * `ctx` (supplied by the adapter; every point in WORLD/content space):
 *   pc, app                      the engine module and the tile's AppBase
 *   eyes()                       { origin, axis, right, up, tanHalfFovX } — the eyes' midpoint
 *                                and the view frame of the first eye
 *   focus()                      the focus point
 *   framing()                    { center, extent } — the box the camera frames, or null
 *   pick(clientX, clientY)       the world point under a canvas point, or null
 *   modelToContent(p)            the splat's own space → world
 *   entity()                     the current asset's entity (entity scope)
 */
export class SplatEffects {
  constructor(ctx) {
    this.ctx = ctx;
    /** scope key ('tile' or an entity) → Map(name → instance) */
    this.scopes = new Map();
    /** scope key → the chunk/modifier structure last installed ('' = none) */
    this._installed = new Map();
    this._disposed = false;
  }

  _scope(key, create = true) {
    let m = this.scopes.get(key);
    if (!m && create) this.scopes.set(key, (m = new Map()));
    return m;
  }

  /** Every instance, as [scopeKey, name, instance]. */
  *_all() {
    for (const [key, m] of this.scopes) for (const [name, inst] of m) yield [key, name, inst];
  }

  _target(opts) {
    if ((opts.scope ?? 'tile') === 'tile') return 'tile';
    const e = opts.entity ?? this.ctx.entity();
    if (!e?.gsplat) throw new Error('@displayxr/inline3d/splat: entity-scope effect before the splat has loaded.');
    return e;
  }

  _makeInstance(name, opts, mode) {
    const def = defOf(name);
    const inst = {
      name,
      def,
      opts,
      mode, // 'play' | 'set'
      state: {},
      startGate: null,
      t0: null, // clock start (after the hold), ms
      startedAt: null,
      amount: 0,
      done: false,
      resolve: null,
      promise: null,
      originPoint: (ctx, eyes) => this._origin(inst, ctx, eyes),
      elapsedS: (tMs) => (inst.startedAt === null ? 0 : Math.max(0, (tMs - inst.startedAt) / 1000)),
    };
    inst.promise = new Promise((r) => (inst.resolve = r));
    return inst;
  }

  _origin(inst, ctx, eyes) {
    const o = inst.opts.origin || { kind: 'focus' };
    if (o.kind === 'eyes') return (eyes || ctx.eyes()).origin;
    if (inst.state.origin) return inst.state.origin;
    let p = null;
    if (o.kind === 'model') p = ctx.modelToContent(o.point);
    else if (o.kind === 'client') p = ctx.pick(o.x, o.y);
    if (!p) p = ctx.focus();
    inst.state.origin = p;
    return p;
  }

  /**
   * Play a transition/pulse/custom effect. Resolves { finished } — true when it ran to its end,
   * false when stopped or replaced. `gate` (a promise) holds it at its START state until settled.
   */
  play(name, opts = {}, { gate = null, entity = null, internal = false } = {}) {
    const o = resolveEffectOptions(name, opts, 'play', { internal });
    if (entity) o.entity = entity;
    const key = this._target(o);
    const inst = this._makeInstance(name, o, 'play');
    this._replace(key, name, inst);
    if (gate) {
      inst.startGate = gate;
      inst.gated = true;
      Promise.resolve(gate).then(
        () => (inst.startGate = null),
        () => (inst.startGate = null),
      );
    }
    this._setupInstance(inst);
    this._apply(key, inst, this.ctx.now());
    this._install(key);
    return inst.promise;
  }

  /**
   * Set (or with null remove) a persistent effect, or hold a transition at a fixed `progress`.
   */
  set(name, params, { entity = null } = {}) {
    if (params === null) {
      if (!defOf(name) || defOf(name).internal) resolveEffectOptions(name, {}, 'set'); // throws
      this.stop(name, { finish: false });
      return;
    }
    const o = resolveEffectOptions(name, params, 'set');
    if (entity) o.entity = entity;
    const key = this._target(o);
    const inst = this._makeInstance(name, o, 'set');
    this._replace(key, name, inst);
    this._setupInstance(inst);
    this._apply(key, inst, this.ctx.now());
    this._install(key);
  }

  /** Internal effects (xfade, wavefront) on one entity, driven by the adapter. */
  setInternal(entity, name, opts) {
    const def = EFFECTS[name];
    const m = this._scope(entity);
    let inst = m.get(name);
    if (opts === null) {
      if (inst) {
        m.delete(name);
        inst.resolve({ finished: false });
        this._install(entity);
      }
      return;
    }
    if (!inst) {
      inst = this._makeInstance(name, { ...def.defaults, ...opts }, 'set');
      m.set(name, inst);
      this._setupInstance(inst);
    } else Object.assign(inst.opts, opts);
    this._apply(entity, inst, this.ctx.now());
    this._install(entity);
  }

  _setupInstance(inst) {
    // Also for a gated one (its held START state needs the geometry); re-run when the gate opens,
    // since the rig/framing may have changed meanwhile (setSource's flip adopts a new asset).
    if (inst.def.start) inst.def.start(this.ctx, inst);
  }

  _replace(key, name, inst) {
    const m = this._scope(key);
    const old = m.get(name);
    if (old) old.resolve({ finished: false });
    m.set(name, inst);
  }

  /**
   * Stop one effect (or every public one with no name). `finish: true` jumps to the end state:
   * an 'in' transition is removed (the untouched asset), an 'out' one holds its end state;
   * `finish: false` (default) removes it — the baseline.
   */
  stop(name, { finish = false, entity = null } = {}) {
    for (const [key, n, inst] of [...this._all()]) {
      if (name ? n !== name : inst.def.internal) continue;
      if (entity && key !== entity) continue;
      const m = this.scopes.get(key);
      if (finish && inst.mode === 'play' && inst.opts.direction === 'out') {
        inst.mode = 'set';
        inst.opts.progress = 1;
        this._apply(key, inst, this.ctx.now());
        inst.resolve({ finished: true });
        continue;
      }
      m.delete(n);
      inst.resolve({ finished: !!finish });
      this._install(key);
    }
  }

  /** What is on, for handle.effects(). */
  list() {
    const out = [];
    for (const [key, name, inst] of this._all()) {
      if (inst.def.internal) continue;
      out.push({
        name,
        scope: key === 'tile' ? 'tile' : 'entity',
        stage: inst.def.stage,
        playing: inst.mode === 'play',
        waiting: !!inst.startGate,
        progress: +inst.progress?.toFixed?.(4) || 0,
      });
    }
    return out;
  }

  /** Forget an entity's effects (released by setSource). Its modifier goes with the entity. */
  dropEntity(entity) {
    const m = this.scopes.get(entity);
    if (!m) return;
    for (const inst of m.values()) inst.resolve({ finished: false });
    this.scopes.delete(entity);
    this._installed.delete(entity);
  }

  /** True while anything needs a per-frame tick. */
  get active() {
    for (const [, m] of this.scopes) if (m.size) return true;
    return false;
  }

  /** Advance clocks and upload uniforms. Called once per frame by the adapter. */
  tick(tMs) {
    if (this._disposed) return;
    for (const [key, name, inst] of [...this._all()]) {
      if (inst.mode === 'play') {
        if (inst.startGate) {
          this._apply(key, inst, tMs); // hold the start state
          continue;
        }
        if (inst.t0 === null) {
          if (inst.gated && inst.def.start) {
            inst.state = {};
            inst.def.start(this.ctx, inst);
          }
          inst.startedAt = tMs;
          inst.t0 = tMs + (inst.opts.holdMs || 0);
        }
      }
      this._apply(key, inst, tMs);
      if (inst.mode === 'play' && inst.rawT >= 1) this._complete(key, name, inst);
    }
  }

  _complete(key, name, inst) {
    const m = this.scopes.get(key);
    if (inst.opts.direction === 'out' || inst.opts.hold === true) {
      inst.mode = 'set';
      inst.opts.progress = 1;
      inst.resolve({ finished: true });
      return;
    }
    m.delete(name);
    inst.resolve({ finished: true });
    this._install(key);
  }

  /** The instance's amount for time tMs, then its uniforms onto the scope's target. */
  _apply(key, inst, tMs) {
    const o = inst.opts;
    let raw;
    if (inst.mode === 'set') raw = o.progress ?? 1;
    else if (inst.startGate || inst.t0 === null) raw = 0;
    else raw = o.durationMs > 0 ? Math.min(1, Math.max(0, (tMs - inst.t0) / o.durationMs)) : 1;
    inst.rawT = raw;
    const eased = inst.mode === 'set' || !o.easingFn ? raw : o.easingFn(raw);
    inst.progress = raw;
    const kind = inst.def.kind;
    let values;
    if (kind === 'transition') {
      const amount = o.direction === 'out' ? 1 - eased : eased;
      inst.amount = amount;
      values = inst.def.uniforms(this.ctx, inst, amount, tMs);
    } else if (kind === 'pulse') {
      values = inst.def.uniforms(this.ctx, inst, eased, tMs);
    } else if (kind === 'custom') {
      values = { p: inst.mode === 'set' ? (o.progress ?? 1) : eased, t: inst.elapsedS(tMs) };
    } else {
      values = inst.def.uniforms(this.ctx, inst);
    }
    const P = prefixOf(inst.name);
    const set = this._setter(key);
    for (const [k, v] of Object.entries(values)) set(P + k, v);
    if (kind === 'custom' && o.uniforms) {
      for (const [k, v] of Object.entries(o.uniforms)) set(k, typeof v === 'function' ? v(tMs) : v);
    }
    if (key === 'tile') this._tileDirty = true;
  }

  _setter(key) {
    if (key === 'tile') {
      const mat = this._tileMaterial();
      return (n, v) => mat?.setParameter(n, v);
    }
    const g = key.gsplat;
    return (n, v) => g?.setParameter?.(n, v);
  }

  _tileMaterial() {
    return this.ctx.app()?.scene?.gsplat?.material ?? null;
  }

  /** Called after tick: the tile material's uniforms went up this frame. */
  flush() {
    if (this._tileDirty) {
      this._tileDirty = false;
      this._tileMaterial()?.update?.();
    }
  }

  /** (Re)install the generated modifier of one scope if its STRUCTURE changed. */
  _install(key) {
    const m = this.scopes.get(key);
    const insts = m ? [...m.values()] : [];
    const composed = insts.length ? composeModifier(insts) : null;
    const fragment = key === 'tile' ? insts.find((i) => i.opts.fragmentGlsl)?.opts.fragmentGlsl ?? null : null;
    const sig = composed ? composed.code + (fragment || '') : '';
    if ((this._installed.get(key) ?? '') === sig) return;
    this._installed.set(key, sig);
    const pc = this.ctx.pc();
    if (key === 'tile') {
      const mat = this._tileMaterial();
      if (!mat) return;
      const chunks = mat.getShaderChunks(pc.SHADERLANGUAGE_GLSL);
      if (composed) chunks.set('gsplatModifyVS', composed.code);
      else chunks.delete('gsplatModifyVS');
      if (fragment) chunks.set('gsplatModifyPS', fragment);
      else chunks.delete('gsplatModifyPS');
      // re-upload every instance's uniforms onto the (possibly new) program
      if (m) for (const inst of m.values()) this._apply(key, inst, this.ctx.now());
      mat.update();
      return;
    }
    const g = key.gsplat;
    if (!g) return;
    if (composed) {
      g.setWorkBufferModifier?.({ glsl: composed.code });
      if ('workBufferUpdate' in g) g.workBufferUpdate = pc.WORKBUFFER_UPDATE_ALWAYS ?? 2;
    } else {
      g.setWorkBufferModifier?.(null);
      if ('workBufferUpdate' in g) g.workBufferUpdate = pc.WORKBUFFER_UPDATE_ONCE ?? 1;
      this.scopes.delete(key);
      this._installed.delete(key);
    }
  }

  /** Remove everything (restores the engine's chunks). */
  dispose() {
    for (const [, , inst] of this._all()) inst.resolve({ finished: false });
    for (const key of [...this.scopes.keys()]) {
      this.scopes.get(key).clear();
      try {
        this._install(key);
      } catch {
        // the app may already be destroyed
      }
    }
    this.scopes.clear();
    this._disposed = true;
  }
}

// ── option entry points for ./splat (validated at the page's own call) ───────────────────────

/** The error Spark's handle throws for every effect entry point. */
export function effectsNotOnSpark(what) {
  return new Error(
    `@displayxr/inline3d/splat: ${what} — splat effects are PlayCanvas-only in this version. Pass ` +
      "engine:'playcanvas' (docs/splat-effects.md); Spark ports are a follow-up.",
  );
}

/** Validate a playEffect/setEffect call (throws), without running it. */
export function validateEffectCall(name, opts, mode) {
  if (mode === 'set' && opts === null) {
    if (!defOf(name) || defOf(name).internal) resolveEffectOptions(name, {}, 'set');
    return;
  }
  resolveEffectOptions(name, opts ?? {}, mode);
}

/**
 * addSplat's / setSource's `reveal`: false/undefined → null; a name → that transition with its
 * defaults; { type, durationMs, holdMs, easing, origin, … } → the same, overridden. Throws on
 * anything else.
 */
export function resolveRevealOption(reveal) {
  if (reveal === undefined || reveal === false || reveal === null) return null;
  const spec = typeof reveal === 'string' ? { type: reveal } : reveal;
  if (!spec || typeof spec !== 'object' || typeof spec.type !== 'string') {
    throw new TypeError(
      `@displayxr/inline3d/splat: reveal must be false, one of ${REVEAL_EFFECTS.map((r) => `'${r}'`).join(', ')}, or { type, durationMs, holdMs, easing, origin }.`,
    );
  }
  if (!REVEAL_EFFECTS.includes(spec.type)) {
    throw new Error(`@displayxr/inline3d/splat: reveal type '${spec.type}' — expected one of ${REVEAL_EFFECTS.join(', ')}.`);
  }
  const { type, ...rest } = spec;
  if (rest.direction === 'out') throw new Error('@displayxr/inline3d/splat: a reveal plays in (direction \'in\').');
  const opts = resolveEffectOptions(type, { ...rest, direction: 'in' }, 'play');
  return { type, raw: { ...rest, direction: 'in' }, opts };
}

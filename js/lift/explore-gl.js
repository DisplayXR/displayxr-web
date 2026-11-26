// lift/explore-gl.js — the GL-facing pieces of the PlayCanvas explore renderer (./explore.js)
// that do not need the engine itself: the render-time splat modifier, the footprint patch, and the
// state hand-over between the engine and the live DIBR on their ONE shared WebGL2 context.
// Imported by ./explore.js; unit-tested (test/lift-explore-pc.test.mjs) without playcanvas.

// ── the depth modifier (reveal + depth gain) and the fade, as ONE render-time chunk ──────────
//
// The engine's TILE hook: `app.scene.gsplat.material`'s `gsplatModifyVS`, the unified renderer's
// render-time vertex stage (run for every splat, every view, every frame — no work-buffer
// re-render, the hook ./inline3d-splat-effects.js uses). Centres are WORLD space, which here is
// the capture frame: camera at the origin looking down −z, y up (the OpenCV flip lives on the
// splat entity; the orbit lives on the eyes), so depth along the view axis is −z for EVERY axes
// convention.
//
// Every splat is slid along the ray from a centre of projection `o` so its depth becomes
// t' = D + (t − D)·s — the plane t = D (the pivot) stays put — and its scales are multiplied by
// the same λ, so its footprint seen FROM `o` does not change. From `o` the modifier is invisible;
// from the two eyes either side of it, only the disparity changes. s = FLAT_RESIDUAL → gain is the
// reveal ("the photo inflates into depth"); s = gain at rest is setDepthGain. The same function the
// Spark renderer ran as a dyno graph. λ keeps each splat on its own ray from `o`, so the engine's
// sort (by ORIGINAL centres) stays a valid back-to-front order.
//
// ASSEMBLE (uLiftA, 0 -> 1; >= 1 = off, the exact baseline): the arrival the viewer can see. Every
// splat is a particle with its own start time: it appears as a dot away from its place and flies
// home, the centre of the picture first. Keys and paths read the splat's ORIGINAL world centre
// and uLiftA only, never a screen input, so both eyes of a woven tile see the same particle in the
// same place (docs/splat-effects.md, "the one rule"). uLiftARmax = the picture's half diagonal as
// a tangent (image units), which sizes both the ordering and the scatter.
export const LIFT_MODIFY_VS = /* glsl */ `
uniform float uLiftS;
uniform vec3 uLiftO;
uniform float uLiftD;
uniform float uLiftFade;
uniform float uLiftA;
uniform float uLiftARmax;
float gLiftLp = 1.0;
float liftHash(vec3 c, float s) {
  return fract(sin(dot(c, vec3(12.9898, 78.233, 37.719)) + s) * 43758.5453);
}
// A splat's own progress through the assemble (0 = not launched, 1 = home). Keyed on its ORIGINAL
// world centre only: where it sits in the picture (centre first) plus a per-splat random part.
float liftArrive(vec3 c) {
  if (uLiftA >= 1.0) return 1.0;
  float k = clamp(length(c.xy) / max(-c.z, 1e-3) / max(uLiftARmax, 1e-3), 0.0, 1.0);
  k = mix(k, liftHash(c, 1.0), 0.35);
  return clamp((uLiftA - k * 0.6) / 0.4, 0.0, 1.0);
}
float liftLambda(vec3 c) {
  float t = -c.z;
  float ot = -uLiftO.z;
  float dt = t - ot;
  if (dt <= 1e-4) return 1.0;
  float tFlat = uLiftD + (t - uLiftD) * uLiftS;
  return (tFlat - ot) / dt;
}
void modifySplatCenter(inout vec3 center) {
  vec3 c0 = center;
  center = uLiftO + (center - uLiftO) * liftLambda(center);
  gLiftLp = liftArrive(c0);
  if (gLiftLp < 1.0) {
    // Away from home by e, eased out: sideways in the picture, and only ever FARTHER than home
    // (never toward the viewer: a particle in front of the scene is an uncomfortable disparity).
    float e = (1.0 - gLiftLp) * (1.0 - gLiftLp);
    float t = max(-center.z, 1e-3);
    vec2 dir = vec2(liftHash(c0, 2.0), liftHash(c0, 3.0)) - 0.5;
    center.xy += dir * (1.2 * uLiftARmax * t * e);
    center.z -= t * 0.3 * e * liftHash(c0, 4.0);
  }
}
void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
  scale *= liftLambda(originalCenter);
  // A dot while it flies, its own size over the last stretch: the engine sorts by ORIGINAL
  // centres, so a splat away from home blends out of order, and a dot overlaps almost nothing.
  float lp = liftArrive(originalCenter);
  if (lp < 1.0) scale *= mix(0.12, 1.0, smoothstep(0.55, 1.0, lp));
}
void modifySplatColor(vec3 center, inout vec4 color) {
  color.a *= uLiftFade * smoothstep(0.0, 0.2, gLiftLp);
}
`;

/**
 * The shader override for the engine's non-square-pixel footprint bug — a copy of
 * ../inline3d-splat-playcanvas.js `patchGsplatFootprint` (kept here so the lift bundle does not
 * pull the whole addSplat adapter in; test/lift-explore-pc.test.mjs asserts the two agree).
 * `gsplatCornerVS` derives ONE focal from the viewport WIDTH for both axes of the Jacobian; the
 * lift's eye viewports have square pixels today (each eye is display-width in the SBS store), so
 * this changes nothing there — it is here so a caller that squeezes the eyes still draws round
 * splats. Adapted from PlayCanvas engine gsplatCorner.js @ v2.22.3, MIT (THIRD_PARTY_NOTICES.md).
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

/**
 * Put the WebGL state another renderer moved back under the engine's caches — the PlayCanvas
 * equivalent of three's `renderer.resetState()`. The live DIBR (js/lift/live-dibr.js) binds its
 * own program, VAO, textures on units 0/1, toggles blend/depth/scissor and pixel-store flags on
 * the SAME context between our frames; the engine caches all of that and would skip calls it
 * believes redundant. `initializeRenderState()` re-issues blend/depth/cull/stencil/scissor/
 * pixel-store AND resets their caches (no allocation that leaks); the rest are dropped by hand.
 * NOT `initializeContextCaches()`: it replaces the VAO map, which would leak every VAO per frame.
 */
export function adoptGlState(device) {
  const gl = device.gl;
  if (!gl) return;
  device.initializeRenderState();
  gl.bindVertexArray(null);
  device.boundVao = null;
  gl.useProgram(null);
  device.shader = null;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  device.activeFramebuffer = null;
  if (typeof device.initTextureUnits === 'function') device.initTextureUnits(device.maxCombinedTextures);
  device.vertexBuffers = [];
}

/**
 * Force the GL pixel-store (UNPACK_*) state to what the engine's caches believe. Cheap and safe to
 * call mid-pass (unlike adoptGlState). The engine uploads a loaded texture IMMEDIATELY
 * (Texture.upload → WebglTexture.uploadImmediate → setTexture) from an async load continuation,
 * outside our draws; with its caches stale, a sibling renderer's UNPACK_PREMULTIPLY_ALPHA (or
 * FLIP_Y) would be applied to a .sog's data planes — premultiplied sh0 / quats are garbage.
 */
export function syncUnpackState(device) {
  const gl = device.gl;
  if (!gl) return;
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !!device.unpackFlipY);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !!device.unpackPremultiplyAlpha);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  if (Number.isFinite(device.unpackAlignment)) gl.pixelStorei(gl.UNPACK_ALIGNMENT, device.unpackAlignment);
}

/**
 * And the other way: leave the context the way a plain WebGL2 renderer (the DIBR) expects to
 * find it — default framebuffer, no VAO/program, the fixed-function toggles off, the browser's
 * default colour-space conversion on uploads (the engine sets NONE, which would skip the page
 * image's colour conversion in the DIBR's next texImage2D).
 */
export function releaseGlState(gl) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindVertexArray(null);
  gl.useProgram(null);
  gl.disable(gl.SCISSOR_TEST);
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.STENCIL_TEST);
  gl.disable(gl.POLYGON_OFFSET_FILL);
  gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
  gl.disable(gl.RASTERIZER_DISCARD);
  gl.colorMask(true, true, true, true);
  gl.depthMask(true);
  gl.activeTexture(gl.TEXTURE0);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
}


// Layer 0's soft matte, and its final packing.
//
// A foreground pixel with a far-side neighbour sits on the silhouette: its colour is a mix of the
// two surfaces. Its alpha is the closed-form two-colour matte — the projection of its colour onto
// the segment from the local background mean to the local foreground mean (a guided-filter-style
// local linear model over a (2·uR+1)² window) — blended 20 % toward a prior so a silhouette whose
// two sides share a colour still gets a ramp.
//
// TIGHT by design (quality pass, 2026-09-25): only pixels whose background neighbour is within
// uR px (default 1) are matted, so the opacity ramp is ≤ 1.5 px at the output raster. The old 2 px
// ramp (5×5 window, 0.5/0.85 prior) left a band of 30–50 % opaque splats round every object that
// read as a soft halo once the background slid behind it.
//
// UN-MIXING. A matted pixel's colour still carries the background it was photographed against;
// drawn with alpha α over a DIFFERENT background (the orbit's reveal) that becomes a fringe of the
// old background. The foreground colour is recovered as F = (c − (1−α)·B)/α, pulled toward the
// local foreground mean where α is small (the estimate is noisy there), and packed into z as a
// 24-bit integer (exact in float32); w = 1 flags a silhouette pixel (the emitter also caps its
// surfel anisotropy there).
//
// in : uD R32F, uRGB RGBA8   out: RGBA32F (d̂, α, packedRGB | −1, silhouette) — layer 0
export default /* glsl */ `
uniform sampler2D uD;
uniform sampler2D uRGB;
uniform ivec2 uPad;
uniform ivec2 uInner;
uniform float uTau;
uniform int uR;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 q = p - uPad;
  float d = texelFetch(uD, p, 0).r;
  if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, uInner))) { o = vec4(d, 0.0, -1.0, 0.0); return; }
  // on the silhouette only if a background pixel is within uR
  bool sil = false;
  for (int j = -2; j <= 2; j++)
    for (int i = -2; i <= 2; i++)
      if (max(abs(i), abs(j)) <= uR && tap(uD, p + ivec2(i, j)).r < d - uTau) sil = true;
  float a = 1.0;
  float packed = -1.0;
  if (sil) {
    // local background / foreground colour means over the window one ring wider than uR (a 1-px
    // ring alone is mostly mixed pixels)
    vec3 sb = vec3(0.0), sf = vec3(0.0);
    float nb = 0.0, nf = 0.0;
    for (int j = -3; j <= 3; j++)
      for (int i = -3; i <= 3; i++) {
        if (max(abs(i), abs(j)) > uR + 1) continue;
        ivec2 s = p + ivec2(i, j);
        ivec2 sq = s - uPad;
        if (any(lessThan(sq, ivec2(0))) || any(greaterThanEqual(sq, uInner))) continue;
        float ds = texelFetch(uD, s, 0).r;
        vec3 cs = texelFetch(uRGB, s, 0).rgb;
        if (ds < d - uTau) { sb += cs; nb += 1.0; }
        else if (abs(ds - d) < 0.5 * uTau) { sf += cs; nf += 1.0; }
      }
    vec3 c = texelFetch(uRGB, p, 0).rgb;
    vec3 cbg = sb / max(nb, 1.0);
    vec3 cfg = nf > 0.0 ? sf / nf : c;
    vec3 ab = cfg - cbg;
    float l2 = dot(ab, ab);
    const float prior = 0.6;
    float am = l2 > 0.004 ? clamp(dot(c - cbg, ab) / l2, 0.0, 1.0) : prior;
    a = clamp(mix(am, prior, 0.2), 0.15, 1.0);
    vec3 F = clamp((c - (1.0 - a) * cbg) / a, 0.0, 1.0);
    F = mix(cfg, F, smoothstep(0.3, 0.8, a));
    vec3 b8 = floor(F * 255.0 + 0.5);
    packed = b8.r * 65536.0 + b8.g * 256.0 + b8.b;
  }
  o = vec4(d, a, packed, sil ? 1.0 : 0.0);
}
`;

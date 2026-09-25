// Layer 0's soft matte, and its final packing.
//
// A foreground pixel within 2 px of a far-side neighbour sits on the silhouette: its colour is
// a mix of the two surfaces, and drawn opaque it reads as a hard, haloed cut-out once the
// background slides behind it. Its alpha is the closed-form two-colour matte — the projection
// of its colour onto the segment from the local background mean to the local foreground mean
// (a guided-filter-style local linear model) — blended 30 % toward a distance prior (0.5 at
// 1 px, 0.85 at 2 px) so a silhouette whose two sides share a colour still gets a ramp.
//
// in : uD R32F, uRGB RGBA8   out: RGBA32F (d̂, α, 0, 0) — layer 0
export default /* glsl */ `
uniform sampler2D uD;
uniform sampler2D uRGB;
uniform ivec2 uPad;
uniform ivec2 uInner;
uniform float uTau;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 q = p - uPad;
  float d = texelFetch(uD, p, 0).r;
  if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, uInner))) { o = vec4(d, 0.0, 0.0, 0.0); return; }
  vec3 cbg = vec3(0.0), cfg = vec3(0.0);
  float nbg = 0.0, nfg = 0.0, near = 9.0;
  for (int j = -2; j <= 2; j++)
    for (int i = -2; i <= 2; i++) {
      ivec2 s = p + ivec2(i, j);
      ivec2 sq = s - uPad;
      if (any(lessThan(sq, ivec2(0))) || any(greaterThanEqual(sq, uInner))) continue;
      float ds = texelFetch(uD, s, 0).r;
      vec3 c = texelFetch(uRGB, s, 0).rgb;
      if (ds < d - uTau) { cbg += c; nbg += 1.0; near = min(near, float(max(abs(i), abs(j)))); }
      else if (abs(ds - d) < 0.5 * uTau) { cfg += c; nfg += 1.0; }
    }
  float a = 1.0;
  if (nbg > 0.0) {
    cbg /= nbg; cfg /= max(nfg, 1.0);
    vec3 c = texelFetch(uRGB, p, 0).rgb;
    vec3 ab = cfg - cbg;
    float l2 = dot(ab, ab);
    float prior = near <= 1.0 ? 0.5 : 0.85;
    float am = l2 > 0.004 ? clamp(dot(c - cbg, ab) / l2, 0.0, 1.0) : prior;
    a = clamp(mix(am, prior, 0.3), 0.1, 1.0);
  }
  o = vec4(d, a, 0.0, 0.0);
}
`;

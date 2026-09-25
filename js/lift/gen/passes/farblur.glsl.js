// FAR-SIDE SMOOTHING: the far-side fill (./farside) is exact at the silhouette but, being a
// per-axis extrapolation, it streaks deeper into the hole — each column/row carries the colour of
// the one boundary pixel it hit (vertical stripes under a ridge line, rectangles in a cluttered
// room). This pass blurs it with a radius that GROWS with the distance to the edge (r = k·dist,
// capped): sharp where the orbit first reveals it (continuity with the visible background), a
// smooth membrane where only a large orbit reaches. A 7×7 sparse grid of taps spaced r/3 apart.
// COLOUR takes only taps on the same surface (|Δd̂| < uTau). DEPTH takes taps up to uTolD apart
// (lift-gen farBlurDepthTol, 0.15): under a subject the axes pick a far street in one column and a
// nearer hedge or the hair in the next, and every such switch kept at tau was a depth step INSIDE
// layer 1 — at the orbit each opened as a thin vertical crack (the panel's "holes behind the
// subject, uniform"). Smoothed, layer 1 is a continuous sheet there; its colour stays edge-exact.
//
// in : uFX RGBA32F (n, d̂, dist, ·), uFC RGBA32F (rgb, w)   out: the same two, smoothed
export default /* glsl */ `
uniform sampler2D uFX;
uniform sampler2D uFC;
uniform float uGain;
uniform float uMaxR;
uniform float uTau;
uniform float uTolD;
layout(location = 0) out vec4 o;
layout(location = 1) out vec4 oC;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 fx = texelFetch(uFX, p, 0);
  vec4 fc = texelFetch(uFC, p, 0);
  o = fx; oC = fc;
  if (fc.a <= 0.0) return;
  float r = min(uMaxR, uGain * fx.b);
  if (r < 1.0) return;
  float sp = r / 3.0;
  vec3 cs = vec3(0.0); float ds = 0.0, ws = 0.0, wd = 0.0;
  for (int j = -3; j <= 3; j++)
    for (int i = -3; i <= 3; i++) {
      ivec2 s = p + ivec2(round(vec2(float(i), float(j)) * sp));
      vec4 tc = tap(uFC, s);
      if (tc.a <= 0.0) continue;
      vec4 tx = tap(uFX, s);
      float dd = abs(tx.g - fx.g);
      if (dd > uTolD) continue;
      float w = exp(-0.5 * float(i * i + j * j) / 4.0);
      ds += w * tx.g; wd += w;
      if (dd > uTau) continue;
      cs += w * tc.rgb; ws += w;
    }
  if (ws > 0.0) oC = vec4(cs / ws, fc.a);
  if (wd > 0.0) o = vec4(fx.r, ds / wd, fx.b, fx.a);
}
`;

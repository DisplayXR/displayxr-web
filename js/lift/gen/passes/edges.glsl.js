// Depth-discontinuity map, recorded on the FAR side of each edge.
//
// A pixel p is a far-side edge pixel when a neighbour 1 or 2 px away is nearer by more than
// uTau (normalised disparity). The four channels say WHERE that nearer surface is, which is the
// direction the hidden band grows (into the foreground, the part that will slide off the
// background when the viewer moves):
//   r = ΔL  foreground on the LEFT  of p   (so the hole band lies left of p, bg on its right)
//   g = ΔR  foreground on the RIGHT of p
//   b = ΔU  foreground ABOVE p
//   a = ΔD  foreground BELOW p
// Each is the disparity step (0 when there is no edge that way). The 4 % border is never an edge.
//
// in : uD R32F PW×PH   out: RGBA32F
export default /* glsl */ `
uniform sampler2D uD;
uniform ivec2 uPad;
uniform ivec2 uInner;
uniform float uTau;
out vec4 o;
float step1(ivec2 p, ivec2 dir, float d) {
  float n = max(tap(uD, p + dir).r, tap(uD, p + 2 * dir).r);
  float s = n - d;
  return s > uTau ? s : 0.0;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 q = p - uPad;
  if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, uInner))) { o = vec4(0.0); return; }
  float d = texelFetch(uD, p, 0).r;
  // neighbours outside the inner frame are edge-replicated copies (upsample pass), so no false
  // edges appear at the frame; clamp the probe to the inner rect anyway.
  o = vec4(step1(p, ivec2(-1, 0), d), step1(p, ivec2(1, 0), d),
           step1(p, ivec2(0, -1), d), step1(p, ivec2(0, 1), d));
}
`;

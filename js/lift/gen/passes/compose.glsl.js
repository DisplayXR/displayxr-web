// Layer 1 packing, two targets:
//   o  = the BAND (M, or the outpaint border): full-res hidden layer — (r, g, b, d̂₁ | −1000)
//   oB = the BACKPLATE (in the wide mask Mb but not in M): the part of the hidden layer beyond
//        the 5 % band, which the writer emits at HALF resolution — same encoding.
// Inside either, the background is forced at least uTau/2 FARTHER than layer 0 there, so the
// two layers can never z-fight or invert. The sentinel −1000 means "no hidden layer here".
//
// in : uD, uM, uMb, uFA, uFB   out: 2 × RGBA32F
export default /* glsl */ `
uniform sampler2D uD;
uniform sampler2D uM;
uniform sampler2D uMb;
uniform sampler2D uFA;
uniform sampler2D uFB;
uniform float uTau;
layout(location = 0) out vec4 o;
layout(location = 1) out vec4 oB;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 m = texelFetch(uM, p, 0);
  vec4 mb = texelFetch(uMb, p, 0);
  bool border = m.b < -0.5;
  bool inM = m.r + m.g > 0.5;
  bool inB = !inM && !border && mb.r + mb.g > 0.5;
  float d0 = texelFetch(uD, p, 0).r;
  float d1 = texelFetch(uFB, p, 0).r;
  if (!border) d1 = min(d1, d0 - 0.5 * uTau);
  d1 = max(d1, -0.2);
  vec3 c = texelFetch(uFA, p, 0).rgb;
  o = vec4(c, inM ? d1 : -1000.0);
  oB = vec4(c, inB ? d1 : -1000.0);
}
`;

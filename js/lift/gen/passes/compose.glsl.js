// Layer 1 packing, two targets:
//   o  = the BAND (M, or the first uBase px of the outpaint border): full-res hidden layer —
//        (r, g, b, d̂₁ | −1000)
//   oB = the BACKPLATE (in the wide mask Mb but not in M, and the outpaint border beyond uBase):
//        the part of the hidden layer the writer emits at HALF resolution — same encoding.
// Inside the frame the background is forced at least uTau/2 FARTHER than layer 0 there, so the
// two layers can never z-fight or invert. The sentinel −1000 means "no hidden layer here".
//
// DEPTH inside the frame is the far-side estimate (uFX.g, ./farside + ./farblur) where one exists,
// else the push-pull fill's. In the outpaint BORDER it is the edge pixel's own depth (uD replicates
// the nearest frame pixel there — the upsample pass): the border must travel WITH the content it
// continues, or the orbit opens a gap between them (lift-gen.js outpaintBorders sizes it on that
// assumption).
//
// COLOUR inside the frame is the far-side colour (uFC) where one exists, else the push-pull fill's.
// In the border (uMirror) it is the frame reflected across its edge — texture that continues the
// edge instead of a smear — fading into the push-pull colour over the border's width.
//
// in : uD, uM, uMb, uFA, uFB, uFX, uFC, uRGB   out: 2 × RGBA32F
export default /* glsl */ `
uniform sampler2D uD;
uniform sampler2D uM;
uniform sampler2D uMb;
uniform sampler2D uFA;
uniform sampler2D uFB;
uniform sampler2D uFX;
uniform bool uFarDepth;
uniform sampler2D uFC;
uniform bool uFarColour;
uniform sampler2D uRGB;
uniform ivec2 uPad;
uniform ivec2 uInner;
uniform ivec2 uBase;
uniform ivec2 uBorderW;
uniform bool uMirror;
uniform float uTau;
layout(location = 0) out vec4 o;
layout(location = 1) out vec4 oB;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 q = p - uPad;
  vec4 m = texelFetch(uM, p, 0);
  vec4 mb = texelFetch(uMb, p, 0);
  bool border = m.b < -0.5;
  float d0 = texelFetch(uD, p, 0).r;
  vec3 c = texelFetch(uFA, p, 0).rgb;
  if (border) {
    // distance outside the frame, per axis
    ivec2 out2 = max(max(-q, q - (uInner - 1)), ivec2(0));
    bool far = out2.x > uBase.x || out2.y > uBase.y;
    if (uMirror) {
      ivec2 qm = q;
      if (q.x < 0) qm.x = -q.x - 1; else if (q.x >= uInner.x) qm.x = 2 * uInner.x - q.x - 1;
      if (q.y < 0) qm.y = -q.y - 1; else if (q.y >= uInner.y) qm.y = 2 * uInner.y - q.y - 1;
      qm = clamp(qm, ivec2(0), uInner - 1);
      vec3 cm = texelFetch(uRGB, qm + uPad, 0).rgb;
      float t = max(float(out2.x) / float(max(uBorderW.x, 1)), float(out2.y) / float(max(uBorderW.y, 1)));
      c = mix(cm, c, 0.7 * smoothstep(0.0, 1.0, t));
    }
    float d1 = max(d0, -0.2);
    o = vec4(c, far ? -1000.0 : d1);
    oB = vec4(c, far ? d1 : -1000.0);
    return;
  }
  bool inM = m.r + m.g > 0.5;
  bool inB = !inM && mb.r + mb.g > 0.5;
  float d1 = texelFetch(uFB, p, 0).r;
  vec4 fx = texelFetch(uFX, p, 0);
  if (uFarDepth && fx.r > 0.5) d1 = fx.g;
  d1 = min(d1, d0 - 0.5 * uTau);
  d1 = max(d1, -0.2);
  vec4 fc = texelFetch(uFC, p, 0);
  if (uFarColour && fc.a > 0.0) c = fc.rgb;
  o = vec4(c, inM ? d1 : -1000.0);
  oB = vec4(c, inB ? d1 : -1000.0);
}
`;

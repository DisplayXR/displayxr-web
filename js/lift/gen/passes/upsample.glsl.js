// Joint-bilateral upsample (Kopf et al. 2007) of the low-res normalised disparity to the output
// raster, with the full-res RGB as the guide. Writes the PADDED domain: the 4 % outpaint border
// replicates the nearest inner pixel so later passes see no false edge at the frame.
//
// in : uDlo  R32F  w×h   normalised disparity d̂ ∈ [0,1] (1 = near)
//      uRGB  RGBA8 PW×PH the source raster, placed at uPad
// out: R32F PW×PH d̂
export default /* glsl */ `
uniform sampler2D uDlo;
uniform sampler2D uRGB;
uniform ivec2 uPad;
uniform ivec2 uInner;
uniform float uSigmaS;   // spatial sigma, LOW-RES pixels
uniform float uSigmaR;   // range sigma on RGB (0..1 units)
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 q = clamp(p - uPad, ivec2(0), uInner - 1);
  ivec2 lo = textureSize(uDlo, 0);
  vec2 sc = vec2(lo) / vec2(uInner);
  vec2 pl = (vec2(q) + 0.5) * sc - 0.5;
  ivec2 b = ivec2(floor(pl));
  vec3 c0 = texelFetch(uRGB, q + uPad, 0).rgb;
  float sw = 0.0, sd = 0.0;
  for (int j = -1; j <= 2; j++) {
    for (int i = -1; i <= 2; i++) {
      ivec2 s = clamp(b + ivec2(i, j), ivec2(0), lo - 1);
      vec2 dd = vec2(s) - pl;
      float ws = exp(-dot(dd, dd) / (2.0 * uSigmaS * uSigmaS));
      ivec2 g = clamp(ivec2((vec2(s) + 0.5) / sc), ivec2(0), uInner - 1);
      vec3 dc = texelFetch(uRGB, g + uPad, 0).rgb - c0;
      float wr = exp(-dot(dc, dc) / (2.0 * uSigmaR * uSigmaR));
      float w = ws * (wr + 1e-3);
      sw += w;
      sd += w * texelFetch(uDlo, s, 0).r;
    }
  }
  o = vec4(sd / sw, 0.0, 0.0, 1.0);
}
`;

// Grey EROSION of disparity = separable min-filter (a min over a (2R+1)² box, run as a
// horizontal then a vertical 1-D pass). Erosion of disparity pulls the FAR value into every
// pixel within R of it, so after it a foreground pixel near a depth edge carries the depth of
// the background it occludes. lift-gen uses it to decide which pixels may seed the hidden
// layer's fill (a pixel much nearer than its eroded value is foreground-near-an-edge and must
// NOT seed the background).
//
// in : uD R32F, uDir = (1,0) or (0,1), uR radius (px, ≤ 256)   out: R32F
export default /* glsl */ `
uniform sampler2D uD;
uniform ivec2 uDir;
uniform int uR;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float m = texelFetch(uD, p, 0).r;
  for (int k = 1; k <= 256; k++) {
    if (k > uR) break;
    m = min(m, min(tap(uD, p + uDir * k).r, tap(uD, p - uDir * k).r));
  }
  o = vec4(m, 0.0, 0.0, 1.0);
}
`;

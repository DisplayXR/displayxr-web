// Depth-edge SNAP: kill "flying pixels". A monocular depth net draws a discontinuity as a soft
// ramp several pixels wide; unprojected, that ramp is a rubber sheet stretched between the
// foreground and the background — the single most visible artefact of a naive lift at ±15°.
// Where a 7×7 window spans more than uStep of disparity (a real step, not a slope: a ground
// plane moves ~0.002/px), each pixel is assigned to whichever extreme it is closer to.
//
// in : uD R32F   out: R32F
export default /* glsl */ `
uniform sampler2D uD;
uniform float uStep;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float d = texelFetch(uD, p, 0).r;
  float mn = d, mx = d;
  for (int j = -3; j <= 3; j++)
    for (int i = -3; i <= 3; i++) {
      float s = tap(uD, p + ivec2(i, j)).r;
      mn = min(mn, s);
      mx = max(mx, s);
    }
  if (mx - mn > uStep) d = (d - mn < mx - d) ? mn : mx;
  o = vec4(d, 0.0, 0.0, 1.0);
}
`;

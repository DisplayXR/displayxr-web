// The hidden-layer mask M: a DIRECTIONAL dilation of the far side of every depth edge, into the
// foreground, by the width the background can be revealed at the maximum orbit angle.
//
// For a camera that orbits by θ about a pivot at depth zp, the background behind an edge slides
// relative to the foreground by  w = f · zp · tanθ · |1/z_bg − 1/z_fg|  pixels. uBand is
// f·zp·tanθ·(invNear − invFar), i.e. pixels per unit of normalised disparity step, so an edge
// of step Δ opens a band of Δ·uBand px (clamped to uK, 5 % of the width).
//
// This is a GATHER: each pixel searches the four axis directions, up to uK px, for the nearest
// far-side edge pixel whose band reaches it. It is in the band only if it is itself nearer than
// that edge's background by > uTau/2 (i.e. it is foreground that can slide away).
//
// Split by which side the background is on — the inpainting net is directional:
//   r = maskRight : background to the RIGHT of the hole (foreground on its left)  — edge found to the right
//   g = maskLeft  : background to the LEFT of the hole                             — edge found to the left
//   vertical bands (edge found above/below) go to maskRight.
//   b = distance to the edge in px (−1 in the outpaint border)
//   a = the edge's background disparity
// The outpaint border is always hidden-layer: left half → maskRight, right half → maskLeft.
//
// in : uD R32F, uE RGBA32F (edges)   out: RGBA32F
export default /* glsl */ `
uniform sampler2D uD;
uniform sampler2D uE;
uniform ivec2 uPad;
uniform ivec2 uInner;
uniform int uK;
uniform float uBand;
uniform float uTau;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 q = p - uPad;
  if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, uInner))) {
    bool leftHalf = q.x < uInner.x / 2;
    o = vec4(leftHalf ? 1.0 : 0.0, leftHalf ? 0.0 : 1.0, -1.0, 0.0);
    return;
  }
  ivec2 lo = uPad, hi = uPad + uInner - 1;
  float d = texelFetch(uD, p, 0).r;
  o = vec4(0.0);
  for (int k = 1; k <= 256; k++) {
    if (k > uK) break;
    float fk = float(k);
    bool found = false;
    // edge to the RIGHT whose foreground is on its LEFT (ΔL): we are in that foreground's rim
    ivec2 e = p + ivec2(k, 0);
    if (e.x <= hi.x) {
      float s = texelFetch(uE, e, 0).r;
      float de = texelFetch(uD, e, 0).r;
      if (s > 0.0 && fk <= s * uBand && d > de + 0.5 * uTau) { o = vec4(1.0, 0.0, fk, de); found = true; }
    }
    e = p - ivec2(k, 0);
    if (!found && e.x >= lo.x) {
      float s = texelFetch(uE, e, 0).g;
      float de = texelFetch(uD, e, 0).r;
      if (s > 0.0 && fk <= s * uBand && d > de + 0.5 * uTau) { o = vec4(0.0, 1.0, fk, de); found = true; }
    }
    e = p + ivec2(0, k);
    if (!found && e.y <= hi.y) {
      float s = texelFetch(uE, e, 0).b;
      float de = texelFetch(uD, e, 0).r;
      if (s > 0.0 && fk <= s * uBand && d > de + 0.5 * uTau) { o = vec4(1.0, 0.0, fk, de); found = true; }
    }
    e = p - ivec2(0, k);
    if (!found && e.y >= lo.y) {
      float s = texelFetch(uE, e, 0).a;
      float de = texelFetch(uD, e, 0).r;
      if (s > 0.0 && fk <= s * uBand && d > de + 0.5 * uTau) { o = vec4(1.0, 0.0, fk, de); found = true; }
    }
    if (found) break;
  }
}
`;

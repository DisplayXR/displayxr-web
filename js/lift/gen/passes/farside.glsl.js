// FAR SIDE: for every pixel, the background it hides — gathered on all four axes.
//
// Along each axis direction the pass walks outward (1 px steps to 32 px, then 2 px steps: an edge
// band is ≥ 2 px wide on its far side, so the coarse stride cannot jump one) up to uReach px, and
// takes the FIRST far-side edge pixel whose foreground faces back toward us and whose background
// we are nearer than by more than uTau/2 — the surface this pixel occludes in that direction.
//
//   r = the number of axes that found one (0–4). ≥ 1 ⇒ this pixel is FOREGROUND over something:
//       it may not seed the hidden layer's fill (lift-gen's seed exclusion — without it a big
//       foreground object seeded the fill with its own interior, and the fill blended it into the
//       hole as a translucent copy of the object).
//   g = the hidden layer's depth: the background continued under the object — the found
//       background disparities, those nearer than their MEDIAN by > uTau rejected (for 2 found
//       the median is the farther; for 4 the mean of the middle two), the rest weighted 1/dist². The harmonic (push-pull) depth used
//       before drifted toward whatever near surface bordered the hole — a floor, the frame edge —
//       and, clamped to sit just behind layer 0, it became a SHELL right behind the object that
//       swung out from under it on orbit as a ghost silhouette.
//   b = the distance to the nearest found edge, px (1e4 when none).
//   a = unused.
// and a second target, the far-side COLOUR: the median of the RGB 2, 5 and 9 px beyond each found
// edge (clear of the mixed silhouette pixel and of a photographic halo), from the same axes with the same weights — so a hole is spanned by the background that actually borders it. A push-pull fill
// here averaged in everything within its pyramid footprint (a floor, the frame's border), and the
// hole — the object's own silhouette — came out a shade off the background around it: at orbit
// the mask itself read as a translucent copy of the object.
//   oC = (r, g, b, Σw)   (Σw = 0 ⇒ none found; the caller falls back to push-pull)
//
// in : uD R32F, uE RGBA32F (edges), uRGB RGBA8   out: 2 × RGBA32F
export default /* glsl */ `
uniform sampler2D uD;
uniform sampler2D uE;
uniform ivec2 uPad;
uniform ivec2 uInner;
uniform int uReach;
uniform sampler2D uRGB;
uniform float uHWeight;
uniform float uTau;
layout(location = 0) out vec4 o;
layout(location = 1) out vec4 oC;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 q = p - uPad;
  if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, uInner))) { o = vec4(0.0, 0.0, 1e4, 0.0); oC = vec4(0.0); return; }
  ivec2 lo = uPad, hi = uPad + uInner - 1;
  float d = texelFetch(uD, p, 0).r;
  // per direction: found background disparity (−1 = none)
  float v[4];
  v[0] = -1.0; v[1] = -1.0; v[2] = -1.0; v[3] = -1.0;
  vec3 col[4];
  float dst[4];
  ivec2 dirs[4];
  dirs[0] = ivec2(1, 0); dirs[1] = ivec2(-1, 0); dirs[2] = ivec2(0, 1); dirs[3] = ivec2(0, -1);
  float best = 1e4;
  for (int a = 0; a < 4; a++) {
    for (int k = 1; k <= 256; k++) {
      int dist = k <= 32 ? k : 32 + 2 * (k - 32);
      if (dist > uReach) break;
      ivec2 e = p + dirs[a] * dist;
      if (e.x < lo.x || e.y < lo.y || e.x > hi.x || e.y > hi.y) break;
      vec4 ev = texelFetch(uE, e, 0);
      // the edge's foreground must lie back toward p: walking +x we need ΔL (fg on its left), etc.
      float s = a == 0 ? ev.r : a == 1 ? ev.g : a == 2 ? ev.b : ev.a;
      if (s > 0.0) {
        float de = texelFetch(uD, e, 0).r;
        if (d > de + 0.5 * uTau) {
          v[a] = de; dst[a] = float(dist); best = min(best, float(dist));
          // colour: per-channel median of the background 2, 5 and 9 px past the edge (same
          // surface only) — clear of the mixed pixel AND of a halo/glow the photo itself has
          // round the object (a long-exposure rock), which read as a pale outline at the orbit
          vec3 c2 = texelFetch(uRGB, clamp(e + dirs[a] * 2, lo, hi), 0).rgb;
          vec3 c5 = c2, c9 = c2;
          ivec2 e5 = clamp(e + dirs[a] * 5, lo, hi), e9 = clamp(e + dirs[a] * 9, lo, hi);
          if (abs(texelFetch(uD, e5, 0).r - de) < uTau) c5 = texelFetch(uRGB, e5, 0).rgb;
          if (abs(texelFetch(uD, e9, 0).r - de) < uTau) c9 = texelFetch(uRGB, e9, 0).rgb;
          col[a] = max(min(c2, c5), min(max(c2, c5), c9));
          break;
        }
      }
    }
  }
  // sort the found values (≤ 4, tiny network), median
  float n = 0.0;
  float s0 = 9.0, s1 = 9.0, s2 = 9.0, s3 = 9.0;
  for (int a = 0; a < 4; a++) {
    float x = v[a];
    if (x < -0.5) continue;
    n += 1.0;
    if (x < s0) { s3 = s2; s2 = s1; s1 = s0; s0 = x; }
    else if (x < s1) { s3 = s2; s2 = s1; s1 = x; }
    else if (x < s2) { s3 = s2; s2 = x; }
    else s3 = x;
  }
  float med = n < 0.5 ? 0.0 : n < 2.5 ? s0 : n < 3.5 ? s1 : 0.5 * (s1 + s2);
  // Keep the axes whose background is not NEARER than the median by more than uTau (a nearer
  // one is some other surface — a floor under the object, a neighbouring object), then weight
  // them by 1/distance²: at the visible sliver next to a silhouette the nearest boundary
  // dominates, so the hidden layer is continuous in depth AND colour with the background right
  // there; deep inside the hole (rarely revealed) the axes blend smoothly instead of switching.
  float ds = 0.0, ws = 0.0;
  vec3 cs = vec3(0.0);
  for (int a = 0; a < 4; a++) {
    if (v[a] < -0.5 || v[a] > med + uTau) continue;
    // yaw is the dominant motion (drag, head parallax), and what a horizontal move uncovers is the
    // background continued HORIZONTALLY: under a sloped ridge the sky straight above is nearer
    // than the far hills to the side, and unweighted it painted the reveal as a pale wedge.
    float w = (a < 2 ? uHWeight : 1.0) / (dst[a] * dst[a]);
    ds += w * v[a]; cs += w * col[a]; ws += w;
  }
  o = vec4(n, ws > 0.0 ? ds / ws : med, best, 0.0);
  oC = ws > 0.0 ? vec4(cs / ws, ws) : vec4(0.0);
}
`;

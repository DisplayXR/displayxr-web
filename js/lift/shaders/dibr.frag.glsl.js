// Live DIBR fragment shader: GLSL ES 3.00 port of the single-layer LDI ray-marcher
// (dfattal.github.io Shaders/rayCastMonoLDI.glsl, ImmersityLens rayCastMono2StereoLDI.glsl),
// specialised to ONE layer and re-expressed in SCREEN coordinates, because the SDK's per-view
// off-axis (Kooima) projection already maps the display window onto the viewport — that is the
// job the RGBD player's `sk2` skew + `f2` focal did by hand. See docs/lift-dibr.md.
//
// Coordinates (all in units of the display-window HEIGHT, origin at the window centre, +y up,
// +z toward the viewer):
//   p'   output pixel on the display plane          ((u-0.5)*A, v-0.5)
//   E    this view's eye                             uEye  (from the projection matrix)
//   D0   distance of the virtual SOURCE camera       uD0   (centred, same distance as the eyes)
//   q    relative parallax of a scene point, q = z/(D0 - z) — linear in disparity, 0 on the glass.
// A ray from E through p' reaches depth z at lateral r = E + (p' - E)(E.z - z)/E.z, which the
// source camera sees at x_s = r * (1 + q). For E.z == D0 this is the familiar x_s = p' + E.xy*q
// (the marcher's  s1 = s2 + C.xy*invZ  with the convergence skew folded in).
export default /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uColor;   // source frame, UNPACK_FLIP_Y -> v=0 bottom
uniform sampler2D uDisp;    // raw (dilated) disparity, row 0 = image TOP, R16F bilinear
uniform vec2  uDispRes;     // depth texture size (px)
uniform float uLo, uHi;     // percentile range of raw disparity -> n in [0,1]
uniform float uConv;        // convergence, normalised n that lands on the glass
uniform float uQScale;      // q per unit of (n - conv): budget * A / (kappa * D0) * gain
uniform float uTaper;       // border taper width, fraction of the image
uniform float uAspect;      // A = window width / height
uniform vec3  uEye;         // eye relative to window centre, in window heights
uniform float uD0;          // source-camera distance, window heights
uniform int   uSteps;       // coarse march steps

// Map sample uv (source) -> relative parallax q at that pixel.
float qAt(vec2 uvs) {
  float d = texture(uDisp, vec2(uvs.x, 1.0 - uvs.y)).r;
  float n = clamp((d - uLo) / max(uHi - uLo, 1e-6), 0.0, 1.0);
  vec2 b = min(uvs, 1.0 - uvs);
  // taper distance measured in WIDTH units on both axes
  float t = uTaper > 0.0 ? smoothstep(0.0, uTaper, min(b.x, b.y / uAspect)) : 1.0;
  return uQScale * (n - uConv) * t;
}

// Source uv for the ray through output p' at relative parallax q.
vec2 srcUv(vec2 pp, float q) {
  float z = q * uD0 / (1.0 + q);
  vec2 r = uEye.xy + (pp - uEye.xy) * ((uEye.z - z) / uEye.z);
  vec2 xs = r * (1.0 + q);
  return vec2(xs.x / uAspect + 0.5, xs.y + 0.5);
}

void main() {
  vec2 pp = vec2((vUv.x - 0.5) * uAspect, vUv.y - 0.5);
  float qNear = uQScale * (1.0 - uConv);
  float qFar  = uQScale * (0.0 - uConv);
  // Conservative bracket: the taper pulls borders to 0, so include 0.
  qNear = max(qNear, 0.0);
  qFar  = min(qFar, 0.0);

  // ---- coarse march, near -> far: first step where the surface is in front of the ray ----
  float dq = (qNear - qFar) / float(uSteps);
  float q = qNear;
  float qPrev = qNear;
  bool hit = false;
  for (int i = 0; i <= 64; i++) {
    if (i > uSteps) break;
    q = qNear - dq * float(i);
    if (qAt(srcUv(pp, q)) >= q) { hit = true; break; }
    qPrev = q;
  }
  if (!hit) q = qFar;
  // ---- bisection refine between qPrev (ray in front of surface) and q (behind/on) ----
  if (hit && q != qPrev) {
    float a = qPrev, b = q;
    for (int k = 0; k < 6; k++) {
      float m = 0.5 * (a + b);
      if (qAt(srcUv(pp, m)) >= m) b = m; else a = m;
    }
    q = b;
  }
  vec2 uv = srcUv(pp, q);

  // ---- disocclusion: background-side gather (iw3 shift_fill equivalent) ----
  // Probe the disparity a couple of depth texels either side along the parallax direction.
  // A steep jump means the hit landed on the stretched edge ramp: move the colour sample to
  // the BACKGROUND side by the width of the hole this eye opens there (|E.xy| * dq_edge), so a
  // neutral view (E.xy == 0) is never touched, and blend a short blur along the same line.
  vec2 dir = length(uEye.xy) > 1e-6 ? normalize(uEye.xy) : vec2(1.0, 0.0);
  vec2 texel = vec2(dir.x / uDispRes.x, dir.y / uDispRes.y);
  vec2 dUv = texel * 2.0;
  float qa = qAt(uv - dUv), qb = qAt(uv + dUv);
  float jump = abs(qa - qb);
  float edge = smoothstep(0.15, 0.5, jump / max(abs(uQScale), 1e-6));
  // Only a hit ON the ramp is a hole: a hit on the foreground plateau next to the edge keeps
  // its own colour (that is the occluding silhouette, not a disocclusion).
  edge *= clamp(2.0 * (max(qa, qb) - q) / max(jump, 1e-6), 0.0, 1.0);
  vec4 col = texture(uColor, uv);
  float hole = length(uEye.xy) * jump;                 // hole width, window heights
  if (edge > 0.0 && hole > 0.0) {
    float side = qa < qb ? -1.0 : 1.0;                   // toward the lower (farther) q
    vec2 step1 = vec2(dir.x / uAspect, dir.y) * hole * side;
    vec2 ub = uv + step1 + dUv * side;
    vec4 bg = 0.5 * texture(uColor, ub) + 0.25 * texture(uColor, ub + step1 * 0.5)
            + 0.25 * texture(uColor, ub - step1 * 0.25);
    col = mix(col, bg, edge * clamp(hole * uDispRes.y * 0.5, 0.0, 1.0));
  }
  outColor = vec4(col.rgb, 1.0);
}
`;

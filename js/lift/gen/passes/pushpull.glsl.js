// Push-pull scattered-data fill (Gortler et al. 1996) — the hidden layer's background DEPTH, and
// its colour when no inpainting net is supplied.
//
// Seeds are pixels that are provably background: inside the frame, outside M, and not nearer
// than their eroded disparity by more than uTau (so foreground near an edge never seeds). The
// fill therefore extends the background under the foreground rim, and past the frame edge into
// the outpaint border, as a smooth (harmonic-like) continuation.
//
// Every level is two RGBA32F targets:  A = (r, g, b, w)   B = (d, w, 0, 0)

/** seeds: MRT out (A, B) */
export const init = /* glsl */ `
uniform sampler2D uD;
uniform sampler2D uEro;
uniform sampler2D uRGB;
uniform sampler2D uM;
uniform ivec2 uPad;
uniform ivec2 uInner;
uniform float uTau;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 q = p - uPad;
  bool inner = all(greaterThanEqual(q, ivec2(0))) && all(lessThan(q, uInner));
  vec4 m = texelFetch(uM, p, 0);
  float d = texelFetch(uD, p, 0).r;
  float ero = texelFetch(uEro, p, 0).r;
  float w = (inner && m.r + m.g < 0.5 && d <= ero + uTau) ? 1.0 : 0.0;
  oA = vec4(texelFetch(uRGB, p, 0).rgb, w);
  oB = vec4(d, w, 0.0, 0.0);
}
`;

/** push (down): 2×2 weighted mean; w = min(1, Σw) */
export const down = /* glsl */ `
uniform sampler2D uA;
uniform sampler2D uB;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 s = textureSize(uA, 0);
  vec3 c = vec3(0.0); float dsum = 0.0, w = 0.0;
  for (int j = 0; j < 2; j++)
    for (int i = 0; i < 2; i++) {
      ivec2 cp = 2 * p + ivec2(i, j);
      if (cp.x >= s.x || cp.y >= s.y) continue;
      vec4 a = texelFetch(uA, cp, 0);
      float d = texelFetch(uB, cp, 0).r;
      c += a.rgb * a.a; dsum += d * a.a; w += a.a;
    }
  if (w > 0.0) { c /= w; dsum /= w; }
  float wo = min(1.0, w);
  oA = vec4(c, wo);
  oB = vec4(dsum, wo, 0.0, 0.0);
}
`;

/** pull (up): F_l = w_l·c_l + (1 − w_l)·bilinear(F_{l+1}) */
export const up = /* glsl */ `
uniform sampler2D uA;   // this level's pushed values
uniform sampler2D uB;
uniform sampler2D uFA;  // the coarser level, already filled
uniform sampler2D uFB;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 f = (vec2(p) + 0.5) * 0.5 - 0.5;
  ivec2 b = ivec2(floor(f));
  vec2 t = f - vec2(b);
  vec3 c00 = tap(uFA, b).rgb, c10 = tap(uFA, b + ivec2(1, 0)).rgb, c01 = tap(uFA, b + ivec2(0, 1)).rgb, c11 = tap(uFA, b + ivec2(1, 1)).rgb;
  float d00 = tap(uFB, b).r, d10 = tap(uFB, b + ivec2(1, 0)).r, d01 = tap(uFB, b + ivec2(0, 1)).r, d11 = tap(uFB, b + ivec2(1, 1)).r;
  vec3 cu = mix(mix(c00, c10, t.x), mix(c01, c11, t.x), t.y);
  float du = mix(mix(d00, d10, t.x), mix(d01, d11, t.x), t.y);
  vec4 a = texelFetch(uA, p, 0);
  float d = texelFetch(uB, p, 0).r;
  oA = vec4(mix(cu, a.rgb, a.a), 1.0);
  oB = vec4(mix(du, d, a.a), 1.0, 0.0, 0.0);
}
`;

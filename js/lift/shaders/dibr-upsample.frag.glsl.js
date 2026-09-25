// Live DIBR pre-passes at (capped) VIDEO resolution: joint-bilateral upsample of the low-res raw
// disparity with the video frame as the guide, EDGE SNAP on depth edges, then an optional
// separable foreground max filter. See docs/lift-dibr.md § "Edge-aware upsample".
// Same math as the still generator's gen/passes/upsample.glsl.js (Kopf et al. 2007, 4×4 low-res
// taps, spatial sigma in LOW-RES px, range sigma on RGB 0..1) — not the same string: that pass
// works in the generator's padded, texelFetch'd raster; this one keeps live-DIBR's orientation.
//
// Orientation: the output texture has live-DIBR's DEPTH orientation (row 0 = image TOP), so the
// main shader samples it exactly like the raw low-res map (vec2(u, 1 - v)). The colour texture is
// uploaded with UNPACK_FLIP_Y (v = 0 bottom), hence the 1 - y on every guide lookup.
// The output is RAW disparity (a convex combination of raw values): normalisation stays two
// uniforms in the main pass, so an EMA step never re-runs this.
/** Box-filtered guide at DEPTH resolution (row 0 = top, like the depth): the colour each depth
 *  sample "saw", used for the edge snap's foreground / background colour means. 4 bilinear taps
 *  spanning the footprint, so a 1280 → 364 reduction doesn't alias on texture. */
export const GUIDE_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uColor;  // v = 0 bottom
uniform vec2 uOutRes;
out vec4 o;
void main() {
  vec2 xy = gl_FragCoord.xy / uOutRes;
  vec2 h = 0.25 / uOutRes;
  vec2 uv = vec2(xy.x, 1.0 - xy.y);
  o = vec4(0.25 * (texture(uColor, uv + vec2(-h.x, -h.y)).rgb + texture(uColor, uv + vec2(h.x, -h.y)).rgb
                 + texture(uColor, uv + vec2(-h.x, h.y)).rgb + texture(uColor, uv + vec2(h.x, h.y)).rgb), 1.0);
}
`;

// Joint-bilateral upsample + EDGE SNAP.
//
// JBU alone moves a depth edge by at most its ±1.5-texel support (~5 px at 1280 from 364), but the
// network's silhouettes are FAT: VDA-S puts the foreground edge 3–5 depth px OUTSIDE the object
// (measured on real clips, docs/lift-dibr.md), and the live latency adds motion on top. That band
// of background at foreground depth is the halo that rides with people. The snap re-decides every
// pixel of a depth EDGE window by colour, using only samples the network cannot have got wrong:
//   foreground CORE = samples still near the local max after a min filter of radius uCore
//                     (uDlo.g) — at least uCore depth px inside the network's silhouette;
//   background CORE = samples still near the local min after a max filter (uDlo.b).
// The pixel's colour is projected on the segment bgMean → fgMean (the two-colour matte also used
// by the still generator's matte pass) and its depth set between the two cores' mean depths.
// Ambiguous colour (the two means too close), a window without both cores, or no edge at all fall
// back to the JBU value, so the pass never does worse than JBU where the colours can't tell.
export const UPSAMPLE_FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uDlo;    // depth res, row 0 = top: r = raw disparity, g = min-filtered, b = max-filtered
uniform sampler2D uGuide;  // depth res colour (GUIDE_FRAG), row 0 = top
uniform sampler2D uColor;  // video frame, v = 0 bottom
uniform vec2  uOutRes;     // output raster (px)
uniform float uSigmaS;     // JBU spatial sigma, low-res px
uniform float uSigmaR;     // JBU range sigma, RGB 0..1
uniform int   uSnap;       // 0 = JBU only
uniform int   uSnapR;      // snap window radius, depth px (<= 8)
uniform float uSnapTau;    // min local depth range (RAW units) for a pixel to be on an edge
out vec4 o;
void main() {
  vec2 lo = vec2(textureSize(uDlo, 0));
  ivec2 loI = textureSize(uDlo, 0) - 1;
  vec2 xy = gl_FragCoord.xy / uOutRes;              // 0..1, y measured from the TOP
  vec3 c0 = texture(uColor, vec2(xy.x, 1.0 - xy.y)).rgb;
  vec2 pl = xy * lo - 0.5;                          // low-res texel coordinates
  vec2 b = floor(pl);
  float inv2s = 1.0 / (2.0 * uSigmaS * uSigmaS);
  float inv2r = 1.0 / (2.0 * uSigmaR * uSigmaR);
  float sw = 0.0, sd = 0.0;
  for (int j = -1; j <= 2; j++) {
    for (int i = -1; i <= 2; i++) {
      ivec2 s = clamp(ivec2(b) + ivec2(i, j), ivec2(0), loI);
      vec2 dd = vec2(s) - pl;
      float ws = exp(-dot(dd, dd) * inv2s);
      vec3 dc = texelFetch(uGuide, s, 0).rgb - c0;
      float w = ws * (exp(-dot(dc, dc) * inv2r) + 1e-3);
      sw += w;
      sd += w * texelFetch(uDlo, s, 0).r;
    }
  }
  float dj = sd / sw;
  o = vec4(dj, 0.0, 0.0, 1.0);
  if (uSnap == 0) return;

  // ---- edge snap ----
  // Local foreground / background levels = the core-filtered maps, sampled BILINEARLY so every
  // quantity below is continuous in the output pixel (a per-texel window made texel-sized steps).
  // Their gap is non-zero exactly within uCore depth px of a network edge: the uncertain band.
  vec3 here = texture(uDlo, (pl + 0.5) / lo).rgb;
  float dmax = here.b, dmin = here.g;
  float rng = dmax - dmin;
  float eW = smoothstep(uSnapTau, 2.0 * uSnapTau, rng);    // soft edge gate
  if (eW <= 0.0) return;
  float th = 0.25 * rng;
  ivec2 ci = ivec2(floor(pl + 0.5));
  float R = float(uSnapR);
  float inv2c = 1.0 / (2.0 * 0.36 * R * R);                   // sigma = 0.6 R

  vec3 sf = vec3(0.0), sb = vec3(0.0);
  float nf = 0.0, nb = 0.0, df = 0.0, db = 0.0;
  for (int j = -12; j <= 12; j++) {
    if (abs(j) > uSnapR) continue;
    for (int i = -12; i <= 12; i++) {
      if (abs(i) > uSnapR) continue;
      ivec2 s = clamp(ci + ivec2(i, j), ivec2(0), loI);
      vec2 dd = vec2(ci + ivec2(i, j)) - pl;
      // radial gaussian, faded to 0 before the square window's edge: a sample entering or leaving
      // the window must not step the means (it did, as texel-aligned blocks, with a hard cut)
      float w = exp(-dot(dd, dd) * inv2c) * clamp(R - length(dd), 0.0, 1.0);
      vec3 t = texelFetch(uDlo, s, 0).rgb;
      vec3 g = texelFetch(uGuide, s, 0).rgb;
      // soft core membership: still at the foreground level after the min filter / still at the
      // background level after the max filter
      float wf = w * smoothstep(dmax - 2.0 * th, dmax - 0.5 * th, t.g);
      float wb = w * (1.0 - smoothstep(dmin + 0.5 * th, dmin + 2.0 * th, t.b));
      sf += wf * g; df += wf * t.r; nf += wf;
      sb += wb * g; db += wb * t.r; nb += wb;
    }
  }
  float conf = smoothstep(0.05, 0.4, min(nf, nb));          // both cores present
  if (conf <= 0.0) return;
  vec3 cf = sf / nf, cb = sb / nb;
  vec3 ab = cf - cb;
  float l2 = dot(ab, ab);
  float sep = smoothstep(0.005, 0.02, l2);                  // colours can't tell fg from bg -> JBU
  if (sep <= 0.0) return;
  float aC = clamp(dot(c0 - cb, ab) / l2, 0.0, 1.0);        // two-colour matte
  float aM = clamp((dj - dmin) / rng, 0.0, 1.0);            // the network's own say
  float a = smoothstep(0.3, 0.7, mix(aC, aM, 0.2));
  float ds = mix(db / nb, df / nf, a);
  o = vec4(mix(dj, ds, eW * sep * conf), 0.0, 0.0, 1.0);
}
`;

/** One direction of a separable max filter (foreground dilation) on an R16F raster. */
export const MAX_FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uSrc;
uniform ivec2 uDir;        // (1,0) or (0,1)
uniform int   uRadius;     // px, <= 8
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 hi = textureSize(uSrc, 0) - 1;
  float m = texelFetch(uSrc, p, 0).r;
  for (int k = 1; k <= 8; k++) {
    if (k > uRadius) break;
    m = max(m, texelFetch(uSrc, clamp(p + uDir * k, ivec2(0), hi), 0).r);
    m = max(m, texelFetch(uSrc, clamp(p - uDir * k, ivec2(0), hi), 0).r);
  }
  o = vec4(m, 0.0, 0.0, 1.0);
}
`;

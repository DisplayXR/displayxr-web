// inline3d-pc-look.js — the PlayCanvas LOOK helpers shared by the model and splat adapters: the two
// generated image-based environments (the neutral studio and three's room), their yaw constants,
// and the KHR_materials_transmission fix-ups (prepareTransmission).
//
// EXPERIMENTAL and internal, like the two adapters that use it (docs/sdk-stability.md).
//
// WHY A MODULE OF ITS OWN. These lived in inline3d-model-playcanvas.js until 1.19. The splat
// adapter needs them for setRig('display') and imported that module lazily to get them — but that
// module also holds the meshopt decoder, a literal `import('meshoptimizer/decoder')` for the
// OPTIONAL `meshoptimizer` peer. Bundlers follow every import() in the graph, so every bundled app
// using only `./splat` failed to build unless it installed meshoptimizer. This module must never
// import anything that reaches `meshoptimizer` (test/splat-no-meshopt.test.mjs walks the graph).
// inline3d-model-playcanvas.js imports from here and re-exports the names it always exported.
//
// Takes the engine namespace as an argument (`pc`) — no static import of playcanvas.

const TAG = '[inline3d/model]';

// ── lighting ────────────────────────────────────────────────────────────────────────────────

/**
 * THE DEFAULT ENVIRONMENT: a neutral photo studio, generated in memory as an equirect radiance
 * map — a floor-to-ceiling brightness profile plus a handful of soft area lights (spherical
 * Gaussians). The parameters were FITTED (least squares, solid-angle weighted) to the glTF Sample
 * Viewer's "Studio Neutral" environment, so that this backend's default lighting matches the
 * Khronos reference; the image itself is ours (a dozen numbers, not a copy of the HDRI), so the
 * SDK ships no asset and carries no attribution requirement. Grey by construction (r = g = b).
 *
 * `profile` is the radiance at evenly spaced polar angles from straight up (0) to straight down
 * (π); `lobes` are [amplitude, sharpness, polar, azimuth] with the direction
 * (sinθ·cosφ, cosθ, sinθ·sinφ) — Y up, the engine's equirect convention. A lobe's amplitude may
 * be negative (a dark backdrop); the result is clamped at 0.
 */
export const NEUTRAL_STUDIO = Object.freeze({
  profile: [5.003, 5.049, 3.917, 1.968, 1.378, 0.893, 0.8074, 0.7525, 0.6427, -0.1814],
  lobes: [
    [11.31, 4.869, 0.9712, 6.105],
    [1.759, 3.839, 1.404, 3.558],
    [0.9139, 1.621, 1.719, 6.239],
    [0.572, 7.846, 1.497, 6.066],
    [0.6379, 7.687, 1.42, 6.385],
    [-0.7782, 6.701, 1.13, 6.133],
    [-1.263, 8.179, 1.671, 6.188],
    [-1.456, 7.734, 1.256, 6.568],
    [-6.7, 0.8014, 0.449, 6.171],
    [0.4015, 3.915, 1.621, 5.688],
    [-0.5387, 6.494, 2.828, 5.614],
    [6.623, 1.864, 0.7199, 6.135],
    [0.2623, 6.922, 1.755, 5.903],
    [0.2597, 6.906, 1.566, 5.934],
    [0.1584, 6.954, 1.514, 6.179],
    [0.2272, 6.945, 1.422, 5.891],
    [0.03496, 6.974, 1.414, 6.205],
    [0.3804, 6.979, 1.393, 6.08],
  ],
});

/** Lobes as [amplitude, sharpness, mx, my, mz] — the trig done once per env, not per texel. */
const _lobeCache = new WeakMap();
function lobesOf(env) {
  let l = _lobeCache.get(env);
  if (!l) {
    l = env.lobes.map(([a, s, th, ph]) => [a, Math.exp(s), Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)]);
    _lobeCache.set(env, l);
  }
  return l;
}

/** Radiance of NEUTRAL_STUDIO (or `env`) toward unit direction (x, y, z). */
export function neutralStudioRadiance(x, y, z, env = NEUTRAL_STUDIO) {
  const prof = env.profile;
  const n = prof.length - 1;
  const theta = Math.acos(Math.max(-1, Math.min(1, y)));
  const t = (theta / Math.PI) * n;
  const i = Math.min(n - 1, Math.floor(t));
  const f = t - i;
  let v = prof[i] * (1 - f) + prof[i + 1] * f;
  for (const [a, k, mx, my, mz] of lobesOf(env)) v += a * Math.exp(k * (x * mx + y * my + z * mz - 1));
  return v > 0 ? v : 0;
}

/** RGBE-encode a grey radiance. */
function rgbe(v, out, o) {
  if (!(v > 1e-32)) {
    out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
    return;
  }
  let e = Math.ceil(Math.log2(v));
  let m = v / Math.pow(2, e);
  if (m >= 1) {
    m /= 2;
    e += 1;
  }
  const b = Math.min(255, Math.floor(m * 256));
  out[o] = out[o + 1] = out[o + 2] = b;
  out[o + 3] = e + 128;
}

/**
 * The equirect as RGBE bytes, row 0 = straight up. `u` runs with the azimuth φ = 2π·u, which is
 * the convention the fit used; the engine's own equirect orientation is applied through
 * `scene.skyboxRotation` (§ ENV_YAW_DEG), not baked in here.
 */
const _rgbeCache = new Map();
export function neutralStudioRGBE(width = 256, height = 128, env = NEUTRAL_STUDIO) {
  // Every tile on a page gets the same image: build it once (a copy per call, since the engine
  // may keep the array it is handed).
  const key = env === NEUTRAL_STUDIO ? `${width}x${height}` : null;
  if (key && _rgbeCache.has(key)) return _rgbeCache.get(key).slice();
  const out = new Uint8Array(width * height * 4);
  for (let r = 0; r < height; r++) {
    const theta = ((r + 0.5) / height) * Math.PI;
    const st = Math.sin(theta);
    const y = Math.cos(theta);
    for (let c = 0; c < width; c++) {
      const phi = ((c + 0.5) / width) * 2 * Math.PI;
      rgbe(neutralStudioRadiance(st * Math.cos(phi), y, st * Math.sin(phi), env), out, (r * width + c) * 4);
    }
  }
  if (key) _rgbeCache.set(key, out.slice());
  return out;
}

/**
 * Yaw (degrees about +Y) applied to the generated studio, as `scene.skyboxRotation`. Calibrated
 * headless against the Sample Viewer at its default `environmentRotation` (90°): a sweep over
 * 0/90/180/270 × mirrored, then ±15/±30, has a clean minimum at 0 on all four reference models
 * (the engine's equirect convention already lines up with the layout the fit used). Kept as a
 * named constant so a future engine that flips its convention is a one-line fix.
 */
export const ENV_YAW_DEG = 0;

/** Build the default environment on this app and set it as the scene's envAtlas. */
export function useNeutralStudio(pc, app, yawDeg) {
  return useRgbeEquirect(pc, app, 'inline3d-neutral-studio', neutralStudioRGBE(256, 128), 256, 128, yawDeg);
}

/** A grey RGBE equirect (row 0 = up) → prefiltered envAtlas on the scene. */
function useRgbeEquirect(pc, app, name, bytes, W, H, yawDeg) {
  const tex = new pc.Texture(app.graphicsDevice, {
    name,
    width: W,
    height: H,
    format: pc.PIXELFORMAT_RGBA8,
    type: pc.TEXTURETYPE_RGBE,
    projection: pc.TEXTUREPROJECTION_EQUIRECT,
    mipmaps: false,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
    levels: [bytes],
  });
  return useLightingSource(pc, app, tex, true, yawDeg);
}

/** Any equirect/cube source → prefiltered envAtlas on the scene. */
export function useLightingSource(pc, app, source, own, yawDeg = 0) {
  const lighting = pc.EnvLighting.generateLightingSource(source);
  const atlas = pc.EnvLighting.generateAtlas(lighting);
  lighting.destroy?.();
  if (own) source.destroy?.();
  app.scene.envAtlas = atlas;
  app.scene.skyboxIntensity = 1;
  app.scene.exposure = 1;
  // Always written (identity at 0): a later environment on the same scene must not inherit the
  // previous one's yaw (setRig switches room ↔ neutral on one app).
  if (pc.Quat) app.scene.skyboxRotation = new pc.Quat().setFromEulerAngles(0, yawDeg || 0, 0);
  return atlas;
}

// ── the room environment (environment: 'room') ─────────────────────────────────────────────

/**
 * `environment: 'room'` — three.js's procedural RoomEnvironment, regenerated here without three:
 * the same scene (a white room lit by one point light, six grey boxes, six emissive panels), shaded
 * the way three shades it when `PMREMGenerator.fromScene(new RoomEnvironment(), 0.04)` bakes it —
 * which is exactly what `addModel(…, { engine: 'three', environment: 'room' })` lights with.
 *
 * It exists so a page that chose `'room'` on the three path gets that look on this backend. It is
 * NOT the default: the default (`'neutral'`) is matched to the Khronos Sample Viewer, and three's
 * room is a different, brighter room (mean radiance ~0.97 vs ~0.89, most of it from a 100-nit
 * ceiling panel and two 50-nit wall panels).
 *
 * The scene's numbers (positions, rotations, scales, intensities) are three.js's
 * examples/jsm/environments/RoomEnvironment.js (MIT, © three.js authors), itself after
 * model-viewer's EnvironmentScene. No image is shipped: `roomRadiance` ray-casts the boxes per
 * texel. Checked against three r180's own bake (its PMREM, read back through `textureCubeUV`):
 * texel-to-texel ratio median 1.000 (p10 0.989, p90 1.006), solid-angle-weighted MAE 0.03 unblurred
 * and 0.04 with the 0.04-rad blur. Solids are [cx, cy, cz, angleY, sx, sy, sz] (boxes) and
 * [cx, cy, cz, sx, sy, sz, emissive] (panels), BoxGeometry(1) scaled — i.e. full extents.
 */
export const ROOM_ENVIRONMENT = Object.freeze({
  light: [0.418, 16.199, 0.3, 900, 28, 2], // point light: position, intensity (cd), cutoff distance, decay
  room: [-0.757, 13.219, 0.717, 31.713, 28.305, 28.591], // seen from inside
  boxes: [
    [-10.906, 2.009, 1.846, -0.195, 2.328, 7.905, 4.651],
    [-5.607, -0.754, -0.758, 0.994, 1.97, 1.534, 3.955],
    [6.167, 0.857, 7.803, 0.561, 3.927, 6.285, 3.687],
    [-2.017, 0.018, 6.124, 0.333, 2.002, 4.566, 2.064],
    [2.291, -0.756, -2.621, -0.286, 1.546, 1.552, 1.496],
    [-2.193, -0.369, -5.547, 0.516, 3.875, 3.487, 2.986],
  ],
  panels: [
    [-16.116, 14.37, 8.208, 0.1, 2.428, 2.739, 50],
    [-16.109, 18.021, -8.207, 0.1, 2.425, 2.751, 50],
    [14.904, 12.198, -1.832, 0.15, 4.265, 6.331, 17],
    [-0.462, 8.89, 14.52, 4.38, 5.441, 0.088, 43],
    [3.235, 11.486, -12.541, 2.5, 2.0, 0.1, 20],
    [0.0, 20.0, 0.0, 1.0, 0.1, 1.0, 100],
  ],
  blur: 0.04, // radians — the sigma addModel's three path passes to fromScene
});

/** Every solid as [cx, cy, cz, cosY, sinY, hx, hy, hz, kind (0 room, 1 lit box, 2 panel), emissive]. */
const _roomSolids = new WeakMap();
function roomSolids(env) {
  let out = _roomSolids.get(env);
  if (out) return out;
  const [rx, ry, rz, sx, sy, sz] = env.room;
  out = [[rx, ry, rz, 1, 0, sx / 2, sy / 2, sz / 2, 0, 0]];
  for (const [px, py, pz, a, bx, by, bz] of env.boxes) out.push([px, py, pz, Math.cos(a), Math.sin(a), bx / 2, by / 2, bz / 2, 1, 0]);
  for (const [px, py, pz, bx, by, bz, e] of env.panels) out.push([px, py, pz, 1, 0, bx / 2, by / 2, bz / 2, 2, e]);
  _roomSolids.set(env, out);
  return out;
}

/**
 * Radiance of the room seen from the origin toward unit direction (x, y, z): the nearest solid
 * along the ray. A panel is its emissive value; a wall or box (white, roughness 1, non-metal) is
 * three's direct physical shading from the one point light, unshadowed as in three (the scene casts
 * no shadows) — Lambert plus GGX at alpha 1 (D = 1/π, V = 0.5/(NL+NV), Schlick F0 0.04), with
 * three's inverse-square falloff and its (1 − (d/cutoff)⁴)² window.
 */
export function roomRadiance(x, y, z, env = ROOM_ENVIRONMENT) {
  let best = Infinity;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  let emit = -1;
  let found = false;
  for (const b of roomSolids(env)) {
    const c = b[3];
    const s = b[4];
    // The ray in the solid's frame (a rotation about Y): local = Rᵀ(p − centre).
    const ox = -b[0];
    const oy = -b[1];
    const oz = -b[2];
    const o = [c * ox - s * oz, oy, s * ox + c * oz];
    const d = [c * x - s * z, y, s * x + c * z];
    let t0 = -Infinity;
    let t1 = Infinity;
    let a0 = 0;
    let a1 = 0;
    let miss = false;
    for (let i = 0; i < 3; i++) {
      const h = b[5 + i];
      if (Math.abs(d[i]) < 1e-12) {
        if (o[i] < -h || o[i] > h) {
          miss = true;
          break;
        }
        continue;
      }
      let n = (-h - o[i]) / d[i];
      let f = (h - o[i]) / d[i];
      let sn = -1; // the entry face's outward normal is −axis when the ray runs +axis
      if (n > f) {
        const t = n;
        n = f;
        f = t;
        sn = 1;
      }
      if (n > t0) {
        t0 = n;
        a0 = (i + 1) * sn;
      }
      if (f < t1) {
        t1 = f;
        a1 = -(i + 1) * sn;
      }
    }
    if (miss || t0 > t1 || t1 < 0) continue;
    const inside = b[8] === 0;
    const t = inside ? t1 : t0;
    if (!(t > 0) || t >= best) continue;
    best = t;
    found = true;
    if (b[8] === 2) {
      emit = b[9];
      continue;
    }
    emit = -1;
    const a = inside ? a1 : a0;
    const sg = (inside ? -1 : 1) * Math.sign(a); // the room is seen from inside: its normals point in
    const ax = Math.abs(a) - 1;
    const l0 = ax === 0 ? sg : 0;
    const l2 = ax === 2 ? sg : 0;
    nx = c * l0 + s * l2;
    ny = ax === 1 ? sg : 0;
    nz = -s * l0 + c * l2;
  }
  if (!found) return 0;
  if (emit >= 0) return emit;
  const [lx, ly, lz, I, cutoff, decay] = env.light;
  let tx = lx - x * best;
  let ty = ly - y * best;
  let tz = lz - z * best;
  const dist = Math.hypot(tx, ty, tz);
  tx /= dist;
  ty /= dist;
  tz /= dist;
  const nl = nx * tx + ny * ty + nz * tz;
  if (nl <= 0) return 0;
  const win = Math.max(0, Math.min(1, 1 - Math.pow(dist / cutoff, 4)));
  const E = (I / Math.max(Math.pow(dist, decay), 0.01)) * win * win * nl;
  const nv = Math.max(1e-4, -(nx * x + ny * y + nz * z));
  const hx = tx - x;
  const hy = ty - y;
  const hz = tz - z;
  const vh = Math.max(0, (tx * hx + ty * hy + tz * hz) / Math.hypot(hx, hy, hz));
  const F = 0.04 + 0.96 * Math.pow(1 - vh, 5);
  return (E / Math.PI) * (1 + F * (0.5 / (nl + nv)));
}

/**
 * The room as a float equirect (row 0 = up, the same convention as neutralStudioRGBE), blurred by a
 * Gaussian of `sigma` radians — separable on the sphere: σ in rows, σ/sinθ in columns (wrapping).
 */
export function roomEquirect(W = 256, H = 128, sigma = ROOM_ENVIRONMENT.blur, env = ROOM_ENVIRONMENT) {
  const out = new Float32Array(W * H);
  for (let r = 0; r < H; r++) {
    const th = ((r + 0.5) / H) * Math.PI;
    const st = Math.sin(th);
    const y = Math.cos(th);
    for (let c = 0; c < W; c++) {
      const ph = ((c + 0.5) / W) * 2 * Math.PI;
      out[r * W + c] = roomRadiance(st * Math.cos(ph), y, st * Math.sin(ph), env);
    }
  }
  if (!(sigma > 0)) return out;
  const perRow = Math.PI / H; // radians per row, and per column at the equator
  const tmp = new Float32Array(W * H);
  for (let r = 0; r < H; r++) {
    const st = Math.max(Math.sin(((r + 0.5) / H) * Math.PI), 1e-3);
    const sg = Math.min(sigma / perRow / st, W / 4);
    const R = Math.ceil(3 * sg);
    const k = [];
    let ks = 0;
    for (let i = -R; i <= R; i++) {
      const v = Math.exp(-(i * i) / (2 * sg * sg));
      k.push(v);
      ks += v;
    }
    for (let c = 0; c < W; c++) {
      let a = 0;
      for (let i = -R; i <= R; i++) a += k[i + R] * out[r * W + (((c + i) % W) + W) % W];
      tmp[r * W + c] = a / ks;
    }
  }
  const sg = sigma / perRow;
  const R = Math.ceil(3 * sg);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      let a = 0;
      let ks = 0;
      for (let i = -R; i <= R; i++) {
        const rr = r + i;
        if (rr < 0 || rr >= H) continue;
        const v = Math.exp(-(i * i) / (2 * sg * sg));
        a += v * tmp[rr * W + c];
        ks += v;
      }
      out[r * W + c] = a / ks;
    }
  }
  return out;
}

/** The room as RGBE bytes (cached per size: every tile on a page gets the same image). */
const _roomCache = new Map();
export function roomRGBE(W = 256, H = 128) {
  const key = `${W}x${H}`;
  let bytes = _roomCache.get(key);
  if (!bytes) {
    const f = roomEquirect(W, H);
    bytes = new Uint8Array(W * H * 4);
    for (let i = 0; i < f.length; i++) rgbe(f[i], bytes, i * 4);
    _roomCache.set(key, bytes);
  }
  return bytes.slice();
}

/**
 * Yaw that lines the generated room up with three's world (its +X panel on +X, the ceiling panel
 * overhead). Calibrated headless against three r180's own `environment: 'room'` render on two
 * catalogue meshes: a sweep over 0/90/180/270 × mirrored has a clean minimum at 90, unmirrored, on
 * both. (The neutral studio's 0 is the Sample Viewer's orientation, a different frame.)
 */
export const ROOM_YAW_DEG = 90;

/** Build the room environment on this app and set it as the scene's envAtlas. */
export function useRoomEnvironment(pc, app, yawDeg = ROOM_YAW_DEG) {
  return useRgbeEquirect(pc, app, 'inline3d-room', roomRGBE(256, 128), 256, 128, yawDeg);
}

// ── KHR_materials_transmission / volume on this engine ─────────────────────────────────────

/**
 * The engine reads KHR_materials_transmission (and _volume) into `useDynamicRefraction` +
 * `BLEND_NORMAL`, and a dynamic-refraction material samples the camera's SCENE COLOUR MAP. Three
 * things the engine leaves to the app, all needed for a glass or transmissive glTF to look like
 * it does in the Khronos Sample Viewer (and three):
 *
 *  1. THE GRAB PASS. Nothing renders the scene colour map unless a camera asks for it; without it
 *     the material samples an unbound texture — the storm lantern's burner rendered as a MAGENTA
 *     blob inside its globe (measured). `viewer.useSceneColor()` asks, on every eye camera.
 *  2. PASS ORDER. Both references draw opaque → transmissive → blended. The engine puts a
 *     transmissive material in the ONE back-to-front transparent list with the blended ones, so a
 *     blended globe (depthWrite off) can be drawn before the transmissive body behind it, which
 *     then paints over it — the burner showed THROUGH the lantern's opaque-alpha globe. A sort
 *     distance that puts transmissive draws first (back-to-front among themselves) restores the
 *     order: object MAE 10.7 → 10.2 vs three, 11.2 → 10.8 vs the Sample Viewer.
 *  3. STEREO. The engine turns the refracted point's clip position into a grab-texture UV by
 *     mapping the VIEW's NDC over the WHOLE target (`getGrabScreenPos`). A stereo tile draws two
 *     views side by side into one target, so each eye would sample across both. The patched chunk
 *     measures the offset from THIS fragment instead (NDC delta ÷ NDC-per-pixel, from the
 *     derivatives), which is exact for any viewport and identical in mono.
 */
const GRAB_UV_FN = `
vec2 inline3dGrabUV(vec4 clipPos) {
	vec4 p0 = matrix_viewProjection * vec4(vPositionW, 1.0);
	vec2 n0 = p0.xy / p0.w;
	vec2 dn = clipPos.xy / clipPos.w - n0;
	vec2 perPx = vec2(dFdx(n0.x), dFdy(n0.y));
	vec2 off = vec2(abs(perPx.x) > 1e-9 ? dn.x / perPx.x : 0.0, abs(perPx.y) > 1e-9 ? dn.y / perPx.y : 0.0);
	return (gl_FragCoord.xy + off) * uScreenSize.zw;
}
`;
const _grabChunk = new WeakMap();
let _warnedGrabChunk = false;

/** The engine's refractionDynamicPS with the per-view grab UV (null if its shape is not the expected one). */
function stereoRefractionChunk(pc, device) {
  if (_grabChunk.has(device)) return _grabChunk.get(device);
  let out = null;
  try {
    const src = pc.ShaderChunks?.get?.(device, pc.SHADERLANGUAGE_GLSL)?.get?.('refractionDynamicPS');
    const call = /getGrabScreenPos\(\s*projectionPoint\s*\)/;
    const def = /vec3\s+evalRefractionColor\s*\(/;
    if (typeof src === 'string' && call.test(src) && def.test(src)) {
      out = src.replace(def, (m) => `${GRAB_UV_FN}\n${m}`).replace(call, 'inline3dGrabUV(projectionPoint)');
    }
  } catch {
    out = null;
  }
  if (!out && !_warnedGrabChunk) {
    _warnedGrabChunk = true;
    console.warn(`${TAG} this engine's refraction shader has an unexpected shape; transmissive materials keep the engine's grab UV (correct in mono, not per eye in stereo).`);
  }
  _grabChunk.set(device, out);
  return out;
}

/** Transmissive draws first, back-to-front among themselves (the engine's own key + an offset). */
function transmissiveFirst(mi, camPos, camFwd) {
  const c = mi.aabb.center;
  return 1e6 + (c.x - camPos.x) * camFwd.x + (c.y - camPos.y) * camFwd.y + (c.z - camPos.z) * camFwd.z;
}

/**
 * Apply 1–3 above to every dynamic-refraction mesh under `entity` not already handled (`seen`).
 * Returns how many transmissive mesh instances there are under it (handled now or before) —
 * the caller turns the grab pass on when that is > 0. Cheap to call again: handled ones are skipped.
 */
export function prepareTransmission(pc, entity, device, seen = new WeakSet()) {
  const renders = entity?.findComponents ? entity.findComponents('render') : [];
  let n = 0;
  for (const r of renders) {
    for (const mi of r.meshInstances || []) {
      const m = mi.material;
      if (!m?.useDynamicRefraction) continue;
      n++;
      if (seen.has(mi)) continue;
      seen.add(mi);
      mi.calculateSortDistance = transmissiveFirst;
      if (!seen.has(m)) {
        seen.add(m);
        const chunk = device ? stereoRefractionChunk(pc, device) : null;
        if (chunk && typeof m.getShaderChunks === 'function') {
          m.getShaderChunks(pc.SHADERLANGUAGE_GLSL).set('refractionDynamicPS', chunk);
          m.shaderChunksVersion = pc.CHUNKAPI_2_8 ?? '2.8';
          m.update?.();
        }
      }
    }
  }
  return n;
}

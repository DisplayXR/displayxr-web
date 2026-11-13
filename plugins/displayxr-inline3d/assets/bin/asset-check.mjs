#!/usr/bin/env node
// asset-check — is this glTF/GLB ready for an inline-3D page on a glasses-free 3D display?
// Zero dependencies: reads the glTF JSON, the accessor bounds and the image headers itself.
//
//   node asset-check.mjs <file.glb|file.gltf> [--json] [--target desktop|tablet]
//
// Exit 0 = no FAIL (WARNs allowed), 1 = at least one FAIL, 2 = could not read the file.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join, extname } from 'node:path';

const argv = process.argv.slice(2);
const ti = argv.indexOf('--target');
const target = ti >= 0 ? argv[ti + 1] || 'tablet' : 'tablet';
const file = argv.find((a, i) => !a.startsWith('--') && !(ti >= 0 && i === ti + 1));
const asJson = argv.includes('--json');
if (!file) {
  console.error('usage: asset-check.mjs <file.glb|file.gltf> [--json] [--target desktop|tablet]');
  process.exit(2);
}

// Budgets. Tablet = the weakest supported device class (Adreno 740-class, MAX_TEXTURE_SIZE 4096).
// Both eyes render the whole scene, so a model costs twice what it costs on a 2D page.
const BUDGET = {
  tablet: { tris: 300_000, trisFail: 1_500_000, tex: 2048, texFail: 4096, texMB: 128, fileMB: 25 },
  desktop: { tris: 1_000_000, trisFail: 5_000_000, tex: 4096, texFail: 8192, texMB: 512, fileMB: 60 },
}[target] || null;
if (!BUDGET) { console.error(`unknown --target ${target}`); process.exit(2); }

// ------------------------------------------------------------------------------ load
function load(path) {
  const abs = resolve(path);
  const buf = readFileSync(abs);
  const ext = extname(abs).toLowerCase();
  let json, bin = null;
  if (buf.readUInt32LE(0) === 0x46546c67) { // 'glTF'
    const len = buf.readUInt32LE(8);
    let off = 12;
    while (off < len) {
      const clen = buf.readUInt32LE(off), ctype = buf.readUInt32LE(off + 4);
      const data = buf.subarray(off + 8, off + 8 + clen);
      if (ctype === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
      else if (ctype === 0x004e4942) bin = data;
      off += 8 + clen;
    }
  } else if (ext === '.gltf' || buf[0] === 0x7b) {
    json = JSON.parse(buf.toString('utf8'));
  } else throw new Error('not a glTF/GLB file');
  return { abs, dir: dirname(abs), json, bin, bytes: buf.length };
}

// The bytes of a buffer / image, or null with a reason.
function bufferBytes(g, i) {
  const b = g.json.buffers?.[i];
  if (!b) return { err: `buffer ${i} missing` };
  if (b.uri === undefined) return g.bin ? { data: g.bin } : { err: 'GLB without a BIN chunk' };
  if (b.uri.startsWith('data:')) return { data: Buffer.from(b.uri.split(',')[1], 'base64') };
  const p = join(g.dir, decodeURIComponent(b.uri));
  return existsSync(p) ? { data: readFileSync(p), external: b.uri } : { err: `missing file ${b.uri}`, external: b.uri };
}
function imageBytes(g, img) {
  if (img.bufferView !== undefined) {
    const bv = g.json.bufferViews[img.bufferView];
    const b = bufferBytes(g, bv.buffer);
    if (!b.data) return b;
    return { data: b.data.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength) };
  }
  if (!img.uri) return { err: 'image with no source' };
  if (img.uri.startsWith('data:')) return { data: Buffer.from(img.uri.split(',')[1], 'base64') };
  const p = join(g.dir, decodeURIComponent(img.uri));
  return existsSync(p) ? { data: readFileSync(p), external: img.uri } : { err: `missing file ${img.uri}`, external: img.uri };
}

// Width/height from PNG, JPEG, WebP, KTX2 headers.
function imageSize(d) {
  if (!d || d.length < 24) return null;
  if (d[0] === 0x89 && d[1] === 0x50) return { w: d.readUInt32BE(16), h: d.readUInt32BE(20), fmt: 'png' };
  if (d[0] === 0xff && d[1] === 0xd8) {
    let o = 2;
    while (o + 9 < d.length) {
      if (d[o] !== 0xff) { o++; continue; }
      const m = d[o + 1], len = d.readUInt16BE(o + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: d.readUInt16BE(o + 7), h: d.readUInt16BE(o + 5), fmt: 'jpeg' };
      o += 2 + len;
    }
    return null;
  }
  if (d.toString('ascii', 0, 4) === 'RIFF' && d.toString('ascii', 8, 12) === 'WEBP') {
    const k = d.toString('ascii', 12, 16);
    if (k === 'VP8 ') return { w: d.readUInt16LE(26) & 0x3fff, h: d.readUInt16LE(28) & 0x3fff, fmt: 'webp' };
    if (k === 'VP8L') { const b = d.readUInt32LE(21); return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1, fmt: 'webp' }; }
    if (k === 'VP8X') return { w: 1 + d.readUIntLE(24, 3), h: 1 + d.readUIntLE(27, 3), fmt: 'webp' };
  }
  if (d[0] === 0xab && d.toString('ascii', 1, 4) === 'KTX') return { w: d.readUInt32LE(20), h: d.readUInt32LE(24), fmt: 'ktx2' };
  return null;
}

// ------------------------------------------------------------------------------ maths
const I4 = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a, b) { // column-major a*b
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function trs(n) {
  if (n.matrix) return n.matrix.slice();
  const [x, y, z, w] = n.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale || [1, 1, 1];
  const [tx, ty, tz] = n.translation || [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}
const xf = (m, p) => [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);

// ------------------------------------------------------------------------------ checks
function run(g) {
  const J = g.json;
  const out = [];
  const add = (id, status, summary, extra = {}) => out.push({ id, status, summary, ...extra });
  const info = {};

  // spec version + external files
  if (!J.asset || !/^2\./.test(J.asset.version || '')) add('gltf2', 'fail', `asset.version is ${J.asset?.version}: only glTF 2.0 loads`);
  const missing = [];
  for (let i = 0; i < (J.buffers || []).length; i++) { const b = bufferBytes(g, i); if (b.err) missing.push(b.err); }
  for (const img of J.images || []) { const b = imageBytes(g, img); if (b.err) missing.push(b.err); }
  const externals = [...(J.buffers || []), ...(J.images || [])].filter((x) => x.uri && !x.uri.startsWith('data:')).map((x) => x.uri);
  if (missing.length) add('files', 'fail', `${missing[0]}${missing.length > 1 ? ` (+${missing.length - 1} more)` : ''}: a .gltf is several files; deploy every one (or pack a single .glb: gltf-transform copy in.gltf out.glb)`);
  else add('files', externals.length ? 'warn' : 'pass', externals.length ? `${externals.length} external file(s) (${externals.slice(0, 3).join(', ')}): ship them all, or pack a single .glb` : 'self-contained');

  // extensions that need decoders the page must serve
  const req = J.extensionsRequired || [];
  const used = J.extensionsUsed || [];
  const decoders = [];
  if (used.includes('KHR_draco_mesh_compression')) decoders.push('Draco: serve three/examples/jsm/libs/draco/ at /draco/ (or set decoderPath)');
  if (used.includes('KHR_texture_basisu')) decoders.push('KTX2/Basis: serve three/examples/jsm/libs/basis/ at /basis/');
  if (used.includes('EXT_meshopt_compression')) decoders.push('meshopt: add the meshoptimizer package (import map / package.json), no served files');
  add('decoders', decoders.length ? 'warn' : 'pass', decoders.length ? decoders.join('; ') : 'no compression extension needs a decoder', { doc: 'node_modules/@displayxr/inline3d/docs/authoring-inline-3d.md#compressed-gltf' });
  const unknown = req.filter((e) => !['KHR_draco_mesh_compression', 'KHR_texture_basisu', 'EXT_meshopt_compression', 'KHR_mesh_quantization', 'KHR_texture_transform', 'KHR_materials_emissive_strength'].includes(e));
  if (unknown.length) add('required-ext', 'warn', `extensionsRequired includes ${unknown.join(', ')}: check the engine supports it, or the model will not load`);

  // geometry: triangles, draw calls, bounds
  let tris = 0, prims = 0;
  const meshTris = new Map();
  (J.meshes || []).forEach((m, mi) => {
    let t = 0;
    for (const p of m.primitives || []) {
      prims++;
      const mode = p.mode ?? 4;
      const count = p.indices !== undefined ? J.accessors[p.indices].count : J.accessors[p.attributes.POSITION]?.count || 0;
      if (mode === 4) t += count / 3; else if (mode === 5 || mode === 6) t += Math.max(0, count - 2);
    }
    meshTris.set(mi, t);
  });
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let instances = 0;
  const scene = J.scenes?.[J.scene ?? 0];
  const visit = (ni, parent) => {
    const n = J.nodes[ni];
    const m = mul(parent, trs(n));
    if (n.mesh !== undefined) {
      instances++;
      tris += meshTris.get(n.mesh) || 0;
      for (const p of J.meshes[n.mesh].primitives || []) {
        const a = J.accessors[p.attributes.POSITION];
        if (!a || !a.min || !a.max) continue;
        for (let k = 0; k < 8; k++) {
          const c = [k & 1 ? a.max[0] : a.min[0], k & 2 ? a.max[1] : a.min[1], k & 4 ? a.max[2] : a.min[2]];
          const w = xf(m, c);
          for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], w[d]); hi[d] = Math.max(hi[d], w[d]); }
        }
      }
    }
    for (const c of n.children || []) visit(c, m);
  };
  for (const ni of scene?.nodes || []) visit(ni, I4());
  tris = Math.round(tris);
  info.triangles = tris; info.primitives = prims; info.meshInstances = instances;
  if (tris > BUDGET.trisFail) add('triangles', 'fail', `${tris.toLocaleString()} triangles: both eyes draw them, far over the ${target} budget (${BUDGET.tris.toLocaleString()}). Decimate (gltf-transform simplify, or Blender's Decimate)`);
  else if (tris > BUDGET.tris) add('triangles', 'warn', `${tris.toLocaleString()} triangles: over the ${target} budget of ${BUDGET.tris.toLocaleString()} (both eyes draw them). gltf-transform simplify --ratio 0.5 --error 0.001`);
  else add('triangles', 'pass', `${tris.toLocaleString()} triangles`);
  if (prims > 300) add('draw-calls', 'warn', `${prims} primitives (draw calls x2 eyes): merge by material (gltf-transform join / flatten)`);

  if (isFinite(lo[0])) {
    const size = [0, 1, 2].map((d) => hi[d] - lo[d]);
    const centre = [0, 1, 2].map((d) => (hi[d] + lo[d]) / 2);
    const maxDim = Math.max(...size);
    info.bounds = { size: size.map((v) => +v.toPrecision(4)), centre: centre.map((v) => +v.toPrecision(4)), unitsGuess: maxDim > 50 ? 'centimetres or millimetres?' : 'metres' };
    // addModel frames the subject on the glass by its bounds, so units and offset do not break the
    // page — but a page that places the model in its own scene (addScene) needs metres, centred.
    const st = maxDim > 50 || maxDim < 0.005 ? 'warn' : 'pass';
    add('scale', st, `${size.map((v) => v.toPrecision(3)).join(' x ')} (units), centre ${centre.map((v) => v.toPrecision(3)).join(', ')}` +
      (st === 'warn' ? `: ${maxDim > 50 ? 'probably centimetres/millimetres' : 'tiny'}. addModel frames it anyway; for your own scene rescale to real-world metres (gltf-transform transform... or Blender: apply scale)` : ''));
    const off = Math.hypot(...centre) / Math.max(1e-9, maxDim);
    if (off > 0.5) add('pivot', 'warn', `the bounds centre is ${off.toFixed(1)} x the model's size away from its origin: turning it by its origin swings it off the glass. Recentre (gltf-transform center --pivot center)`);
  } else add('scale', 'warn', 'no POSITION min/max to measure the bounds');

  // textures
  const texInfo = [];
  let texBytes = 0, worst = 0;
  for (const [i, img] of (J.images || []).entries()) {
    const b = imageBytes(g, img);
    const s = b.data ? imageSize(b.data) : null;
    if (!s) { texInfo.push({ i, name: img.name || img.uri || `image ${i}`, size: null }); continue; }
    worst = Math.max(worst, s.w, s.h);
    texBytes += s.w * s.h * 4 * 1.33;
    texInfo.push({ i, name: img.name || img.uri || `image ${i}`, w: s.w, h: s.h, fmt: s.fmt });
  }
  info.textures = texInfo;
  const texMB = texBytes / 1048576;
  if (worst > BUDGET.texFail) add('textures', 'fail', `a ${worst}px texture: over ${BUDGET.texFail} the GPU on a ${target} cannot load it. gltf-transform resize --width ${BUDGET.tex} --height ${BUDGET.tex}`);
  else if (worst > BUDGET.tex || texMB > BUDGET.texMB) add('textures', 'warn', `largest texture ${worst}px, ~${texMB.toFixed(0)} MB of GPU memory once decoded: resize to ${BUDGET.tex} (gltf-transform resize) and compress (gltf-transform webp, or ktx2 with served /basis/)`);
  else add('textures', 'pass', `${texInfo.length} texture(s), largest ${worst || 0}px, ~${texMB.toFixed(0)} MB decoded`);

  // materials that look wrong on a 3D display
  const mats = J.materials || [];
  const blend = mats.filter((m) => m.alphaMode === 'BLEND').length;
  const metal = mats.filter((m) => (m.pbrMetallicRoughness?.metallicFactor ?? 1) > 0.6 && !m.pbrMetallicRoughness?.metallicRoughnessTexture).length;
  const glass = mats.filter((m) => m.extensions && (m.extensions.KHR_materials_transmission || m.extensions.KHR_materials_volume)).length;
  const notes = [];
  if (blend) notes.push(`${blend} alpha-BLEND material(s): sorting errors show as depth errors in stereo; use MASK for cut-outs`);
  if (metal || glass) notes.push(`${metal ? `${metal} metallic` : ''}${metal && glass ? ' and ' : ''}${glass ? `${glass} glass/transmission` : ''} material(s): they need an image-based environment to read (addModel's default 'room'/'neutral', or envMap; not 'studio', a punctual rig), or they render dark`);
  add('materials', notes.length ? 'warn' : 'pass', notes.length ? notes.join('; ') : `${mats.length} material(s), opaque/mask only`);

  // file size
  const fileMB = (g.bytes + (externals.length ? externals.reduce((s, u) => { try { return s + statSync(join(g.dir, decodeURIComponent(u))).size; } catch { return s; } }, 0) : 0)) / 1048576;
  info.fileMB = +fileMB.toFixed(2);
  if (fileMB > BUDGET.fileMB) add('file-size', 'warn', `${fileMB.toFixed(1)} MB to download: gltf-transform optimize in.glb out.glb --compress meshopt --texture-compress webp`);
  else add('file-size', 'pass', `${fileMB.toFixed(1)} MB`);

  // animation (fine, but say so: a moving subject swings off the glass)
  if ((J.animations || []).length) add('animation', 'warn', `${J.animations.length} animation(s): keep the motion's forward swing small (it leaves the glass); addModel plays none unless you ask`);

  const verdict = out.some((c) => c.status === 'fail') ? 'fail' : out.some((c) => c.status === 'warn') ? 'warn' : 'pass';
  return { file: g.abs, target, verdict, checks: out, info, generator: J.asset?.generator || null };
}

let g;
try { g = load(file); } catch (e) { console.error(`asset-check: cannot read ${file}: ${e.message}`); process.exit(2); }
const r = run(g);
if (asJson) console.log(JSON.stringify(r, null, 1));
else {
  console.log(`asset-check  ${r.file}  (target: ${r.target})`);
  for (const c of r.checks) console.log(`  ${c.status.toUpperCase().padEnd(4)}  ${c.id.padEnd(12)} ${c.summary}`);
  console.log(`  verdict: ${r.verdict.toUpperCase()}`);
}
process.exit(r.verdict === 'fail' ? 1 : 0);

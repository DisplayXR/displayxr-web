// Headless stereo harness for handle.setLayerRig + makeSbsMaterial. The page plays the RUNTIME:
// it locates views for whatever rig the SDK declared (the camera-rig oracle, displayxr-common's
// dxr_camera3d_compute_view), hands them to the SDK's frame callback, and reads pixels back.
import * as pc from 'playcanvas';
import { attachPlayCanvasSplat } from '../../js/inline3d-splat-playcanvas.js';

const N = 0.6; // nominal viewer distance (m) — the runtime's; also what we pass as viewerDistance
const IPD = 0.064;
const CSS_W = 1280, CSS_H = 720;
const SCREEN = { w: 0.3, h: 0.3 * (CSS_H / CSS_W) }; // the canvas on the panel, metres
let EYES = [[-IPD / 2, 0, N], [IPD / 2, 0, N]];

// ── oracles (the runtime's two rigs) ──
function rot(q, v) {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
function pose(p, q) {
  const [x, y, z, w] = q;
  const m = new Float32Array(16);
  m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y + w * z); m[2] = 2 * (x * z - w * y);
  m[4] = 2 * (x * y - w * z); m[5] = 1 - 2 * (x * x + z * z); m[6] = 2 * (y * z + w * x);
  m[8] = 2 * (x * z + w * y); m[9] = 2 * (y * z - w * x); m[10] = 1 - 2 * (x * x + y * y);
  m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; m[15] = 1;
  return m;
}
function projT(l, r, d, u, n = 0.05, f = 500) {
  const P = new Float32Array(16);
  P[0] = 2 / (l + r); P[8] = (r - l) / (l + r); P[5] = 2 / (u + d); P[9] = (u - d) / (u + d);
  P[10] = -(f + n) / (f - n); P[11] = -1; P[14] = (-2 * f * n) / (f - n);
  return P;
}
const qOf = (o) => [o.x, o.y, o.z, o.w];
function cameraView(e, rig) {
  const m = rig.metersToVirtual || 1, invd = rig.convergenceDiopters;
  const t = Math.tan(rig.verticalFov / 2), ro = t * (SCREEN.w / SCREEN.h), uo = t;
  const el = [m * e[0], m * e[1], m * (e[2] - N)];
  const q = qOf(rig.orientation);
  const w = rot(q, el);
  const s = [el[0] * invd, el[1] * invd, el[2] * invd], den = 1 + s[2];
  return { pose: pose([rig.position.x + w[0], rig.position.y + w[1], rig.position.z + w[2]], q), proj: projT((ro + s[0]) / den, (ro - s[0]) / den, (uo + s[1]) / den, (uo - s[1]) / den) };
}
function displayView(e, rig) {
  const m2v = rig.virtualDisplayHeight / SCREEN.h, es = (rig.perspectiveFactor ?? 1) * m2v;
  const ez = [e[0] * es, e[1] * es, e[2] * es], W = SCREEN.w * m2v, H = SCREEN.h * m2v;
  const q = rig.orientation ? qOf(rig.orientation) : [0, 0, 0, 1];
  const p = rig.position ? [rig.position.x, rig.position.y, rig.position.z] : [0, 0, 0];
  const w = rot(q, ez);
  return { pose: pose([p[0] + w[0], p[1] + w[1], p[2] + w[2]], q), proj: projT((W / 2 + ez[0]) / ez[2], (W / 2 - ez[0]) / ez[2], (H / 2 + ez[1]) / ez[2], (H / 2 - ez[1]) / ez[2]) };
}
/** The display rig the runtime's rig conversion says a camera rig IS, with ipd = parallax = 1. */
function roundRig(rig) {
  const D = 1 / rig.convergenceDiopters, t = Math.tan(rig.verticalFov / 2), q = qOf(rig.orientation), f = rot(q, [0, 0, -1]);
  return { virtualDisplayHeight: 2 * D * t, perspectiveFactor: SCREEN.h / (2 * N) / t, position: { x: rig.position.x + D * f[0], y: rig.position.y + D * f[1], z: rig.position.z + D * f[2] }, orientation: rig.orientation };
}
function invRigid(m) {
  const o = new Float64Array(16);
  o[0] = m[0]; o[1] = m[4]; o[2] = m[8]; o[4] = m[1]; o[5] = m[5]; o[6] = m[9]; o[8] = m[2]; o[9] = m[6]; o[10] = m[10]; o[15] = 1;
  o[12] = -(o[0] * m[12] + o[4] * m[13] + o[8] * m[14]); o[13] = -(o[1] * m[12] + o[5] * m[13] + o[9] * m[14]); o[14] = -(o[2] * m[12] + o[6] * m[13] + o[10] * m[14]);
  return o;
}
function ndc(P, V, X) {
  const v = [0, 1, 2, 3].map((r) => V[r] * X[0] + V[4 + r] * X[1] + V[8 + r] * X[2] + V[12 + r]);
  const c = [0, 1, 3].map((r) => P[r] * v[0] + P[4 + r] * v[1] + P[8 + r] * v[2] + P[12 + r] * v[3]);
  return [c[0] / c[2], c[1] / c[2]];
}

// ── the fake session ──
let declared = null;
const W = { onFrame: null };
const wall = {
  supported: true,
  addScene(cv, onFrame, o) {
    W.onFrame = onFrame;
    declared = o.viewRig ? JSON.parse(JSON.stringify(o.viewRig)) : { type: 'display', virtualDisplayHeight: o.virtualDisplayHeight || 0.24 };
    return {
      setViewRig(r) { declared = JSON.parse(JSON.stringify(r)); return true; },
      exclude() {}, unexclude() {}, remove() {},
      firstWoven: Promise.resolve({ woven: true }),
    };
  },
};
const canvas = document.createElement('canvas');
canvas.style.cssText = `width:${CSS_W}px;height:${CSS_H}px;display:block`;
document.body.appendChild(canvas);
const layerObj = { getViewport: (v) => v._vp };
function locate() {
  const rig = declared;
  return EYES.map((e, i) => {
    const v = rig.type === 'camera' ? cameraView(e, rig) : displayView(e, rig);
    const half = canvas.width / 2;
    return { projectionMatrix: v.proj, transform: { matrix: v.pose }, _vp: { x: i * half, y: 0, width: half, height: canvas.height } };
  });
}
let running = true;
function loop() {
  if (!running) return;
  W.onFrame?.(locate(), layerObj);
  requestAnimationFrame(loop);
}

const out = {};
const R = { log: [] };
window.__R = R;
const log = (...a) => R.log.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

async function main() {
  const ready = attachPlayCanvasSplat(out, wall, canvas, '../../samples/splat/assets/butterfly.sog', {
    playcanvas: pc, rig: 'camera', convergence: 2,
    intrinsics: { fx: 800, fy: 800, cx: 640, cy: 360, width: 1280, height: 720 },
    focusInput: false, orbit: false, idleSpin: 0, preserveDrawingBuffer: true,
  }, []);
  requestAnimationFrame(loop);
  await ready;
  for (let i = 0; i < 30; i++) await new Promise((r) => requestAnimationFrame(r));
  log('declared', declared);
  const app = out.engine.app;
  const gl = app.graphicsDevice.gl;
  const rigNode = out.viewer.rigNode;

  // the stage layer, after World-transparent, drawn by the eye camera (what the app does)
  const comp = app.scene.layers;
  const stage = new pc.Layer({ name: 'Stage' });
  const wi = comp.getTransparentIndex(comp.getLayerById(pc.LAYERID_WORLD));
  comp.insertOpaque(stage, wi + 1);
  comp.insertTransparent(stage, wi + 2);
  out.engine.camera.camera.layers = [...out.engine.camera.camera.layers, stage.id];
  log('composition', comp.layerList.map((l) => l.name));

  const rig = JSON.parse(JSON.stringify(declared));
  const D = 1 / rig.convergenceDiopters, q = qOf(rig.orientation), fwd = rot(q, [0, 0, -1]);
  const right = rot(q, [1, 0, 0]), up = rot(q, [0, 1, 0]), toward = [-fwd[0], -fwd[1], -fwd[2]];
  const Wc = [rig.position.x + D * fwd[0], rig.position.y + D * fwd[1], rig.position.z + D * fwd[2]];
  const winH = 2 * D * Math.tan(rig.verticalFov / 2);
  /** window coords (a right, b up, c toward viewer — all in window heights / world) → rig space */
  const at = (a, b, c) => [0, 1, 2].map((i) => Wc[i] + a * winH * right[i] + b * winH * up[i] + c * toward[i]);

  const unlit = (name, rgb) => {
    const m = new pc.ShaderMaterial({
      uniqueName: name,
      attributes: { vertex_position: pc.SEMANTIC_POSITION },
      vertexGLSL: 'attribute vec3 vertex_position; uniform mat4 matrix_model; uniform mat4 matrix_viewProjection; void main(){ gl_Position = matrix_viewProjection * matrix_model * vec4(vertex_position,1.0); }',
      fragmentGLSL: `void main(){ gl_FragColor = vec4(${rgb.map((c) => (c / 255).toFixed(4)).join(',')}, 1.0); }`,
    });
    m.cull = pc.CULLFACE_NONE;
    m.update();
    return m;
  };
  const addMesh = (name, mesh, mat, p, s) => {
    const node = new pc.GraphNode(name);
    rigNode.addChild(node);
    node.setLocalPosition(p[0], p[1], p[2]);
    node.setLocalRotation(q[0], q[1], q[2], q[3]);
    node.setLocalScale(s[0], s[1], s[2]);
    const mi = new pc.MeshInstance(mesh, mat, node);
    mi.cull = false;
    stage.addMeshInstances([mi]);
    return node;
  };
  const quadMesh = () => {
    const mesh = new pc.Mesh(app.graphicsDevice);
    mesh.setPositions(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]));
    mesh.setUvs(0, new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]));
    mesh.setIndices([0, 1, 2, 0, 2, 3]);
    mesh.update();
    return mesh;
  };
  const Q = quadMesh();
  const sz = 0.05 * winH;
  // MAGENTA: the contact point, ON the convergence plane (z = 0)
  const pContact = at(-0.25, -0.15, 0);
  addMesh('contact', Q, unlit('mag', [255, 0, 255]), pContact, [sz, sz, 1]);
  // CYAN: a marker 0.3 world units IN FRONT of the plane (pop-out)
  const hPop = 0.5;
  const pPop = at(0.25, -0.15, hPop);
  addMesh('pop', Q, unlit('cyan', [0, 255, 255]), pPop, [sz, sz, 1]);
  // GREEN: a marker 0.5 world units BEHIND the plane (a reflection / pool below z = 0)
  const pBehind = at(0.25, 0.1, -0.5);
  addMesh('behind', Q, unlit('green', [0, 255, 0]), pBehind, [sz, sz, 1]);
  // a cube sitting ON the plane, for the eyeball PNG (grey, not measured)
  const cube = pc.Mesh.fromGeometry(app.graphicsDevice, new pc.BoxGeometry());
  addMesh('cube', cube, unlit('grey', [150, 150, 150]), at(0, -0.3, 0.1), [0.2, 0.2, 0.2]);
  // SBS quad at z = 0: left half BLUE, right half YELLOW
  const c2 = document.createElement('canvas');
  c2.width = 64; c2.height = 32;
  const g2 = c2.getContext('2d');
  g2.fillStyle = '#0000ff'; g2.fillRect(0, 0, 32, 32);
  g2.fillStyle = '#ffff00'; g2.fillRect(32, 0, 32, 32);
  const tex = new pc.Texture(app.graphicsDevice, { width: 64, height: 32, format: pc.PIXELFORMAT_RGBA8, mipmaps: false, minFilter: pc.FILTER_NEAREST, magFilter: pc.FILTER_NEAREST });
  tex.setSource(c2);
  const pSbs = at(0.0, 0.25, 0);
  addMesh('sbs', Q, out.makeSbsMaterial(tex), pSbs, [0.1 * winH, 0.1 * winH, 1]);

  const wait = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); };
  await wait(10);

  function grab() {
    const w = canvas.width, h = canvas.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { w, h, px };
  }
  function centroid(img, x0, x1, test) {
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < img.h; y++) for (let x = x0; x < x1; x++) {
      const i = (y * img.w + x) * 4, r = img.px[i], g = img.px[i + 1], b = img.px[i + 2];
      if (test(r, g, b)) { sx += x; sy += y; n++; }
    }
    return n ? { x: sx / n - x0, y: img.h - 1 - sy / n, n } : null;
  }
  const isMag = (r, g, b) => r > 245 && g < 10 && b > 245;
  const isCyan = (r, g, b) => r < 10 && g > 245 && b > 245;
  const isGreen = (r, g, b) => r < 10 && g > 245 && b < 10;
  const isBlue = (r, g, b) => r < 10 && g < 10 && b > 245;
  const isYel = (r, g, b) => r > 245 && g > 245 && b < 10;
  function measure(img, views) {
    const eyes = views ? views.length : 1;
    const ew = img.w / eyes;
    const res = [];
    for (let e = 0; e < eyes; e++) {
      res.push({
        contact: centroid(img, e * ew, (e + 1) * ew, isMag),
        pop: centroid(img, e * ew, (e + 1) * ew, isCyan),
        behind: centroid(img, e * ew, (e + 1) * ew, isGreen),
        blue: centroid(img, e * ew, (e + 1) * ew, isBlue)?.n || 0,
        yellow: centroid(img, e * ew, (e + 1) * ew, isYel)?.n || 0,
      });
    }
    return res;
  }
  // expected eye-local pixel x of a rig-space point, per eye, through photo views or the round rig
  const expectPx = (X, which, ew, h) => EYES.map((e) => {
    const v = which === 'camera' ? cameraView(e, rig) : displayView(e, roundRig(rig));
    const [nx, ny] = ndc(v.proj, invRigid(v.pose), X);
    return { x: (nx * 0.5 + 0.5) * ew - 0.5, y: (ny * 0.5 + 0.5) * h - 0.5 };
  });
  function hash(img) {
    let hsh = 2166136261;
    for (let i = 0; i < img.px.length; i += 1) hsh = Math.imul(hsh ^ img.px[i], 16777619);
    return (hsh >>> 0).toString(16);
  }
  function png(img) {
    const c = document.createElement('canvas');
    c.width = img.w; c.height = img.h;
    const g = c.getContext('2d');
    const id = g.createImageData(img.w, img.h);
    for (let y = 0; y < img.h; y++) id.data.set(img.px.subarray((img.h - 1 - y) * img.w * 4, (img.h - y) * img.w * 4), y * img.w * 4);
    g.putImageData(id, 0, 0);
    return c.toDataURL('image/png');
  }

  // one synchronous frame + readback (our loop is paused while we measure)
  running = false;
  await wait(2);
  const frameNow = () => { const v = locate(); W.onFrame(v, layerObj); return v; };
  const settle = (n = 3) => { let v; for (let i = 0; i < n; i++) v = frameNow(); return v; };

  // ── 3D, camera rig (today) ──
  let v = settle();
  const A = grab();
  R.cam3d = { m: measure(A, v), hash: hash(A), png: png(A), state: out.layerRigState() };
  // ── 3D, display rig ──
  out.setLayerRig('Stage', 'display', { viewerDistance: N });
  v = settle();
  const B = grab();
  R.disp3d = { m: measure(B, v), hash: hash(B), png: png(B), state: out.layerRigState() };
  // gain 1: the display run with the photo's own views must be pixel-identical to today
  out.setLayerRig('Stage', 'display', { gain: 1 });
  v = settle();
  R.gain1 = { hash: hash(grab()), state: out.layerRigState() };
  out.setLayerRig('Stage', 'display', { viewerDistance: N });
  settle();

  const ew = A.w / 2;
  R.expect = {
    contact: { camera: expectPx(pContact, 'camera', ew, A.h), display: expectPx(pContact, 'display', ew, A.h) },
    pop: { camera: expectPx(pPop, 'camera', ew, A.h), display: expectPx(pPop, 'display', ew, A.h) },
    behind: { camera: expectPx(pBehind, 'camera', ew, A.h), display: expectPx(pBehind, 'display', ew, A.h) },
  };
  R.bufW = A.w; R.bufH = A.h; R.D = D; R.winH = winH; R.hPop = hPop;

  // ── an off-centre, leaning head: still exact? ──
  EYES = [[0.04 - IPD / 2, 0.02, 0.5], [0.04 + IPD / 2, 0.02, 0.5]];
  v = settle();
  R.lean = { m: measure(grab(), v), expect: { contact: expectPx(pContact, 'display', ew, A.h), pop: expectPx(pPop, 'display', ew, A.h) } };
  EYES = [[-IPD / 2, 0, N], [IPD / 2, 0, N]];

  // ── cost: frames with the layer rig vs without, alternating blocks ──
  const px1 = new Uint8Array(4);
  const timeBlock = (n) => { const t0 = performance.now(); for (let i = 0; i < n; i++) { frameNow(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px1); } return (performance.now() - t0) / n; };
  const cost = { on: [], off: [] };
  for (let rep = 0; rep < 6; rep++) {
    out.setLayerRig('Stage', 'camera'); settle(); cost.off.push(timeBlock(60));
    out.setLayerRig('Stage', 'display', { viewerDistance: N }); settle(); cost.on.push(timeBlock(60));
  }
  const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  const dc = () => { frameNow(); return { drawCalls: app.stats?.drawCalls?.total ?? null, renderPasses: app.stats?.misc?.renderTargetCreationTime !== undefined ? null : null }; };
  out.setLayerRig('Stage', 'camera'); settle(); const dOff = dc();
  out.setLayerRig('Stage', 'display', { viewerDistance: N }); settle(); const dOn = dc();
  R.cost = { offMs: med(cost.off), onMs: med(cost.on), off: cost.off, on: cost.on, drawCallsOff: dOff.drawCalls, drawCallsOn: dOn.drawCalls };

  // ── zoom: the photo's rig is untouched by a zoom (it is the pivot), so the stage keeps its place ──
  out.setPose({ zoom: 1.4 });
  v = settle(4);
  R.zoom = { m: measure(grab(), v), state: out.layerRigState() };
  out.setPose({ zoom: 1 });
  settle(4);

  // ── a setSource crossfade with the display rig on: runs to the end, stage still exact after ──
  running = true;
  requestAnimationFrame(loop);
  let err = null;
  try { await out.setSource('../../samples/splat/assets/butterfly.sog', { transition: 'crossfade', durationMs: 400 }); } catch (e) { err = String(e); }
  await wait(20);
  running = false;
  await wait(2);
  v = settle();
  R.afterTransition = { err, m: measure(grab(), v), state: out.layerRigState() };

  // ── mono (the 2D tier): camera vs display must be the SAME pixels ──
  out.setLayerRig('Stage', 'camera');
  out.viewer.onLayerLost(); // startMono: the viewer's own rAF draws the mono camera
  await wait(8);
  const M1 = grab();
  out.setLayerRig('Stage', 'display', { viewerDistance: N });
  await wait(8);
  const M2 = grab();
  R.mono = { cam: { m: measure(M1, null), hash: hash(M1) }, disp: { m: measure(M2, null), hash: hash(M2), state: out.layerRigState() }, png: png(M2) };
  R.done = true;
}
main().catch((e) => { R.error = String(e && e.stack || e); R.done = true; });

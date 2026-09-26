// App-mirror harness for handle.setLayerRig: the photo slideshow app's EXACT sequence, through the
// public entry (./splat's addSplat, the deferred stub), against any SDK copy (?sdk=<dir>):
//   addSplat(photo A, { engine:'playcanvas', rig:'auto', captureFit:'cover', … }) → ready →
//   ensureLayerAfterSplat / ensureLayerBefore (append to handle.engine.camera's layers) →
//   setLayerRig(both, 'display') → setSource(B, crossfade) → re-run ensureLayer* (the photo load) →
//   setSource(A, reassemble) → … and after every swap: layerRigState() + per-eye disparity vs oracle.
import * as pc from 'playcanvas';
const Q = new URLSearchParams(location.search);
const SDK = Q.get('sdk') || '../../js';
const A = Q.get('a'), B = Q.get('b');
const { addSplat } = await import(`${SDK}/inline3d-splat.js`);
const N = 0.6;
const IPD = 0.064;
const CSS_W = 1280, CSS_H = 720;
const SCREEN = { w: 0.3, h: 0.3 * (CSS_H / CSS_W) };
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


// ── the fake session (plays the runtime: views for the rig declared BEFORE this frame) ──
let declared = null;
let onFrame = null;
const wall = {
  supported: true,
  addScene(cv, cb, o) {
    onFrame = cb;
    declared = o?.viewRig ? JSON.parse(JSON.stringify(o.viewRig)) : { type: 'display', virtualDisplayHeight: o?.virtualDisplayHeight || 0.24 };
    return { setViewRig(r) { declared = JSON.parse(JSON.stringify(r)); return true; }, exclude() {}, unexclude() {}, remove() {}, firstWoven: Promise.resolve({ woven: true }) };
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
function loop() { if (!running) return; onFrame?.(locate(), layerObj); requestAnimationFrame(loop); }
const R = { log: [], stages: [], warns: [] };
window.__R = R;
const cw = console.warn.bind(console);
console.warn = (...a) => { const s = String(a[0]); if (s.includes('setLayerRig')) R.warns.push(s); cw(...a); };

// ── the app's own helpers, verbatim in behaviour (displayxr-show-pvt src/lib/pcScene.ts) ──
function ensureLayerAfterSplat(app, camera, name) {
  const comp = app.scene.layers;
  let layer = comp.getLayerByName(name);
  if (!layer) {
    layer = new pc.Layer({ name, opaqueSortMode: pc.SORTMODE_MANUAL, transparentSortMode: pc.SORTMODE_MANUAL });
    const ui = comp.getLayerById(pc.LAYERID_UI);
    const idx = ui ? comp.getTransparentIndex(ui) : -1;
    if (idx >= 0) comp.insertTransparent(layer, idx); else comp.pushTransparent(layer);
  }
  const cam = camera?.camera;
  if (cam && !cam.layers.includes(layer.id)) cam.layers = [...cam.layers, layer.id];
  return layer;
}
function ensureLayerBefore(app, camera, name, before) {
  const comp = app.scene.layers;
  let layer = comp.getLayerByName(name);
  if (!layer) {
    layer = new pc.Layer({ name });
    const at = comp.getTransparentIndex(before);
    if (at >= 0) { comp.insertOpaque(layer, at); comp.insertTransparent(layer, at + 1); } else { comp.pushOpaque(layer); comp.pushTransparent(layer); }
  }
  const cam = camera?.camera;
  if (cam && !cam.layers.includes(layer.id)) cam.layers = [...cam.layers, layer.id];
  return layer;
}
// the Weather layer (weatherPc.ts): after World-transparent, appended to every camera drawing World
function ensureWeather(app) {
  let layer = app.scene.layers.getLayerByName('Weather');
  if (!layer) {
    layer = new pc.Layer({ name: 'Weather', transparentSortMode: pc.SORTMODE_MANUAL });
    const world = app.scene.layers.getLayerById(pc.LAYERID_WORLD);
    app.scene.layers.insertTransparent(layer, app.scene.layers.getTransparentIndex(world) + 1);
  }
  for (const cam of app.root.findComponents('camera')) if (cam.layers.includes(pc.LAYERID_WORLD) && !cam.layers.includes(layer.id)) cam.layers = [...cam.layers, layer.id];
}

const unlit = (name, rgb) => {
  const m = new pc.ShaderMaterial({
    uniqueName: name,
    attributes: { vertex_position: pc.SEMANTIC_POSITION },
    vertexGLSL: 'attribute vec3 vertex_position; uniform mat4 matrix_model; uniform mat4 matrix_viewProjection; void main(){ gl_Position = matrix_viewProjection * matrix_model * vec4(vertex_position,1.0); }',
    fragmentGLSL: `void main(){ gl_FragColor = vec4(${rgb.map((c) => (c / 255).toFixed(4)).join(',')}, 1.0); }`,
  });
  m.cull = pc.CULLFACE_NONE; m.update(); return m;
};
const wait = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); };

async function main() {
  const h = addSplat(wall, canvas, A, { engine: 'playcanvas', playcanvas: pc, rig: 'auto', captureFit: 'cover', orbit: false, idleSpin: 0, focusInput: false, perf: 'exact', preserveDrawingBuffer: true, ...(Q.get('path') ? { playcanvasViewPath: Q.get('path') } : {}) });
  requestAnimationFrame(loop);
  await h.ready;
  await wait(20);
  const app = h.engine.app, root = h.engine.root, eyeCam = h.engine.camera;
  const gl = app.graphicsDevice.gl;
  ensureWeather(app);
  const stageRoot = new pc.Entity('stage-fx', app);
  root.addChild(stageRoot);
  let layers;
  const ensure = () => { const after = ensureLayerAfterSplat(app, eyeCam, 'StageAfterSplat'); const objs = ensureLayerBefore(app, eyeCam, 'StageObjects', after); layers = { after, objs }; };
  ensure();
  const Qm = new pc.Mesh(app.graphicsDevice);
  Qm.setPositions(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0])); Qm.setIndices([0, 1, 2, 0, 2, 3]); Qm.update();
  const mats = { mag: unlit('mag', [255, 0, 255]), cyan: unlit('cyan', [0, 255, 255]), yel: unlit('yel', [255, 255, 0]) };
  mats.yel.blendState = new pc.BlendState(true, pc.BLENDEQUATION_ADD, pc.BLENDMODE_SRC_ALPHA, pc.BLENDMODE_ONE_MINUS_SRC_ALPHA);
  mats.yel.depthWrite = false;
  mats.yel.update();
  const markers = {};
  /** The app's placeStage: markers at the CURRENT photo's convergence plane (world space, under root). */
  function placeStage() {
    const rig = JSON.parse(JSON.stringify(h.viewRig || declared));
    const D = 1 / rig.convergenceDiopters, q = qOf(rig.orientation), fwd = rot(q, [0, 0, -1]);
    const right = rot(q, [1, 0, 0]), up = rot(q, [0, 1, 0]), toward = fwd.map((x) => -x);
    const Wc = [0, 1, 2].map((i) => [rig.position.x, rig.position.y, rig.position.z][i] + D * fwd[i]);
    const winH = 2 * D * Math.tan(rig.verticalFov / 2);
    const at = (a, b, c) => [0, 1, 2].map((i) => Wc[i] + a * winH * right[i] + b * winH * up[i] + c * toward[i]);
    const sz = 0.05 * winH;
    const put = (name, mat, p, layer) => {
      let node = markers[name];
      if (!node) {
        node = markers[name] = new pc.Entity(name, app);
        node.addComponent('render', { meshInstances: [new pc.MeshInstance(Qm, mat)] });
        stageRoot.addChild(node);
      }
      node.render.layers = [layer.id]; // the app's moveToLayer
      const L = new pc.Mat4().setTRS(new pc.Vec3(...p), new pc.Quat(...q), new pc.Vec3(sz, sz, 1));
      const Wm = new pc.Mat4().mul2(h.viewer.rigNode.getWorldTransform(), L);
      node.setPosition(Wm.getTranslation()); node.setRotation(new pc.Quat().setFromMat4(Wm)); node.setLocalScale(Wm.getScale());
    };
    const pContact = at(-0.25, -0.15, 0), pPop = at(0.25, -0.15, 0.15 * D), pPopT = at(0.0, 0.2, 0.15 * D);
    put('contact', mats.mag, pContact, layers.objs);
    put('pop', mats.cyan, pPop, layers.objs);
    // StageAfterSplat is TRANSPARENT-only (the app's pool / glint / frames): a blended marker there
    put('popT', mats.yel, pPopT, layers.after);
    return { rig, pContact, pPop, pPopT };
  }
  let placed = placeStage();
  if (!Q.has('control')) for (const name of ['StageObjects', 'StageAfterSplat']) h.setLayerRig(name, 'display', {});

  function grab() { const w = canvas.width, hh = canvas.height, px = new Uint8Array(w * hh * 4); gl.readPixels(0, 0, w, hh, gl.RGBA, gl.UNSIGNED_BYTE, px); return { w, h: hh, px }; }
  function cx(img, e, test) { const ew = img.w / 2; let s = 0, n = 0; for (let y = 0; y < img.h; y++) for (let x = e * ew; x < (e + 1) * ew; x++) { const i = (y * img.w + x) * 4; if (test(img.px[i], img.px[i + 1], img.px[i + 2])) { s += x - e * ew; n++; } } return n ? s / n : null; }
  const isMag = (r, g, b) => r > 245 && g < 10 && b > 245, isCyan = (r, g, b) => r < 10 && g > 245 && b > 245;
  const exp = (X, which, rig) => EYES.map((e) => { const v = which === 'camera' ? cameraView(e, rig) : displayView(e, roundRig(rig)); const [nx] = ndc(v.proj, invRigid(v.pose), X); return (nx * 0.5 + 0.5) * (canvas.width / 2) - 0.5; });
  async function measure(label) {
    running = false; await wait(2);
    for (let i = 0; i < 4; i++) onFrame(locate(), layerObj);
    const img = grab();
    const st = h.layerRigState();
    const isYel = (r, g, b) => r > 245 && g > 245 && b < 10;
    const got = { contact: [0, 1].map((e) => cx(img, e, isMag)), pop: [0, 1].map((e) => cx(img, e, isCyan)), popT: [0, 1].map((e) => cx(img, e, isYel)) };
    const eD = exp(placed.pPop, 'display', placed.rig), eC = exp(placed.pPop, 'camera', placed.rig);
    const tD = exp(placed.pPopT, 'display', placed.rig), tC = exp(placed.pPopT, 'camera', placed.rig);
    R.stages.push({ label, D: 1 / placed.rig.convergenceDiopters, state: st, eyeLayers: [...eyeCam.camera.layers], got,
      popT: { disparity: got.popT[0] === null ? null : got.popT[0] - got.popT[1], expectDisplay: tD[0] - tD[1], expectCamera: tC[0] - tC[1] },
      popDisparity: got.pop[0] === null ? null : got.pop[0] - got.pop[1], expectDisplay: eD[0] - eD[1], expectCamera: eC[0] - eC[1], contactDisparity: got.contact[0] === null ? null : got.contact[0] - got.contact[1] });
    running = true; requestAnimationFrame(loop);
  }
  await wait(10);
  await measure('A (after setLayerRig)');
  const swaps = [[B, 'crossfade'], [A, 'reassemble'], [B, 'reassemble'], [A, 'crossfade']];
  for (const [src, transition] of swaps) {
    const mid = { states: [] };
    const p = h.setSource(src, { transition, durationMs: 500 });
    const t0 = performance.now();
    while (performance.now() - t0 < 700) { await wait(3); mid.states.push(h.layerRigState().engaged); }
    await p;
    await wait(6);
    ensure(); ensureWeather(app); // the app's photo load re-runs these
    placed = placeStage();
    if (!Q.has('control')) for (const name of ['StageObjects', 'StageAfterSplat']) h.setLayerRig(name, 'display', {}); // applyLayerRig on placeStage (idempotent in the app; harmless here)
    await wait(10);
    await measure(`${transition} → ${src.split('/').pop()} (engaged during: ${mid.states.filter(Boolean).length}/${mid.states.length})`);
  }
  R.done = true;
}
main().catch((e) => { R.error = String(e && e.stack || e); R.done = true; });

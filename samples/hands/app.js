// hands — the `@displayxr/inline3d/hands` surface on its own, the way hello-cube shows the raw
// weave: `watchHands` for the joints, `HandGestureController` for the pinch state, and a plain
// WebGL2 point renderer so nothing stands between the API and the pixels. For a model or a splat
// you would not write any of this: `addModel(wall, canvas, src, { hands: true })`.
//
// What to look for on the panel: the dots sit ON your hand and follow it as it moves (the joints
// arrive in the same rig frame as the eye views); a thumb-to-index pinch turns the cube green
// and the log says which hand; the badge shows the browser's per-frame gate — `AVAILABLE`, or why
// hands are withheld (a camera rig, a posed rig that is not fullscreen, a scaled rig …).

import { createInline3D } from '@displayxr/inline3d';
import { watchHands, HandGestureController, HAND_JOINTS } from '@displayxr/inline3d/hands';

const logEl = document.getElementById('log');
const badge = document.getElementById('badge');
const lines = [];
function log(s) {
  lines.push(s);
  while (lines.length > 30) lines.shift();
  logEl.textContent = lines.join('\n');
  console.log('[hands] ' + s);
}
const f3 = (p) => (p ? `(${p[0].toFixed(3)}, ${p[1].toFixed(3)}, ${p[2].toFixed(3)})` : 'null');

// ── a minimal point renderer ───────────────────────────────────────────────────────────────
const canvas = document.getElementById('c');
const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
const vs = `#version 300 es
uniform mat4 uProj, uView; uniform float uPx;
in vec4 aPos; in vec3 aCol; out vec3 vCol;
void main() {
  vec4 v = uView * vec4(aPos.xyz, 1.0);
  gl_Position = uProj * v;
  gl_PointSize = max(2.0, uPx * aPos.w / max(0.01, -v.z));
  vCol = aCol;
}`;
const fs = `#version 300 es
precision mediump float; in vec3 vCol; out vec4 o;
void main() { vec2 d = gl_PointCoord * 2.0 - 1.0; if (dot(d, d) > 1.0) discard; o = vec4(vCol, 1.0); }`;
function sh(t, s) {
  const o = gl.createShader(t);
  gl.shaderSource(o, s);
  gl.compileShader(o);
  if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o));
  return o;
}
const prog = gl.createProgram();
gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
gl.bindAttribLocation(prog, 0, 'aPos');
gl.bindAttribLocation(prog, 1, 'aCol');
gl.linkProgram(prog);
const U = (n) => gl.getUniformLocation(prog, n);
const buf = gl.createBuffer();
const vao = gl.createVertexArray();
gl.bindVertexArray(vao);
gl.bindBuffer(gl.ARRAY_BUFFER, buf);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 28, 0);
gl.enableVertexAttribArray(1);
gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 16);

function invertRigid(m) {
  const r = new Float32Array(16);
  r[0] = m[0]; r[1] = m[4]; r[2] = m[8];
  r[4] = m[1]; r[5] = m[5]; r[6] = m[9];
  r[8] = m[2]; r[9] = m[6]; r[10] = m[10];
  r[12] = -(r[0] * m[12] + r[4] * m[13] + r[8] * m[14]);
  r[13] = -(r[1] * m[12] + r[5] * m[13] + r[9] * m[14]);
  r[14] = -(r[2] * m[12] + r[6] * m[13] + r[10] * m[14]);
  r[15] = 1;
  return r;
}

// Static scene in the rig frame (display rig, 0.24 m tall): the plane outline and a cube at z=0.
const VDH = 0.24;
const staticPts = [];
const dot = (x, y, z, r, c) => staticPts.push(x, y, z, r, c[0], c[1], c[2]);
{
  const aspect = (screen.width || 16) / (screen.height || 9);
  const h = VDH;
  const w = VDH * aspect;
  const n = 48;
  const red = [0.9, 0.25, 0.25];
  for (let i = 0; i <= n; i++) {
    const a = i / n;
    dot(-w / 2 + a * w, -h / 2, 0, 0.0025, red);
    dot(-w / 2 + a * w, h / 2, 0, 0.0025, red);
    dot(-w / 2, -h / 2 + a * h, 0, 0.0025, red);
    dot(w / 2, -h / 2 + a * h, 0, 0.0025, red);
  }
}
const CUBE = 0.05;
function cubePts(col) {
  const out = [];
  const n = 6;
  const s = CUBE / 2;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const a = -s + (i * CUBE) / n;
      const b = -s + (j * CUBE) / n;
      for (const [x, y, z] of [[a, b, s], [a, b, -s], [a, s, b], [a, -s, b], [s, a, b], [-s, a, b]]) {
        out.push(x, y, z, 0.003, col[0], col[1], col[2]);
      }
    }
  }
  return out;
}

// ── hands ──────────────────────────────────────────────────────────────────────────────────
let wall;
let hands = null; // the latest watchHands frame
let lastGate = 'unset';
let lastLog = 0;
const gestures = new HandGestureController();
const pinched = { left: false, right: false };

function showGate(gate) {
  const txt = gate === 'available' ? 'AVAILABLE' : gate;
  if (txt !== lastGate) {
    lastGate = txt;
    badge.textContent = 'hands: ' + txt;
    badge.style.background = gate === 'available' ? '#2a6' : gate === 'unknown' ? '#555' : '#a33';
    log('gate -> ' + txt);
  }
}

function onHands(f) {
  hands = f;
  showGate(f.gate);
  // The gesture controller decides the pinch (hand-relative thresholds, hysteresis); this page
  // only READS its state — a viewer would take its deltas (see handControls).
  gestures.update({ time: f.time, left: f.left, right: f.right });
  for (const h of ['left', 'right']) {
    const now = gestures.pinched(h);
    if (now !== pinched[h]) {
      pinched[h] = now;
      const s = f[h];
      log(`${h} pinch ${now ? 'START' : 'END'}${s ? ` (tip gap ${(gestures.tipDistance(h) * 1000).toFixed(0)} mm, palm ${(s.palmLength * 1000).toFixed(0)} mm)` : ''}`);
    }
  }
}

// ── the scene callback ─────────────────────────────────────────────────────────────────────
function onFrame(views, layer) {
  const dpr = devicePixelRatio || 1;
  const bw = Math.round(canvas.clientWidth * dpr);
  const bh = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  const pts = staticPts.slice();
  let nHands = 0;
  for (const h of ['left', 'right']) {
    const s = hands && hands[h];
    if (!s) continue;
    nHands++;
    const col = h === 'left' ? [0.35, 0.75, 1.0] : [1.0, 0.75, 0.3];
    for (let i = 0; i < HAND_JOINTS.length; i++) {
      pts.push(s.poses[i * 16 + 12], s.poses[i * 16 + 13], s.poses[i * 16 + 14], s.radii[i] || 0.006, col[0], col[1], col[2]);
    }
  }
  pts.push(...cubePts(pinched.left || pinched.right ? [0.2, 1.0, 0.3] : [0.85, 0.85, 0.9]));

  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts), gl.DYNAMIC_DRAW);
  gl.disable(gl.SCISSOR_TEST);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0.07, 0.07, 0.07, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  gl.useProgram(prog);
  gl.bindVertexArray(vao);
  const n = pts.length / 7;
  const half = canvas.width / 2;
  views.slice(0, 2).forEach((v, i) => {
    const vp = (layer && layer.getViewport && layer.getViewport(v)) || { x: i * half, y: 0, width: half, height: canvas.height };
    gl.viewport(vp.x, vp.y, vp.width, vp.height);
    gl.uniformMatrix4fv(U('uProj'), false, v.projectionMatrix);
    gl.uniformMatrix4fv(U('uView'), false, invertRigid(v.transform.matrix));
    gl.uniform1f(U('uPx'), v.projectionMatrix[5] * vp.height);
    gl.drawArrays(gl.POINTS, 0, n);
  });
  const t = performance.now();
  if (t - lastLog > 1000) {
    lastLog = t;
    const e = views[0].transform.position;
    log(`t=${(t / 1000).toFixed(0)} hands=${nHands} L-wrist=${f3(hands?.left?.wrist)} R-wrist=${f3(hands?.right?.wrist)} eye=(${e.x.toFixed(3)}, ${e.y.toFixed(3)}, ${e.z.toFixed(3)})`);
  }
}

document.getElementById('go').onclick = async () => {
  document.getElementById('go').disabled = true;
  wall = await createInline3D({ lazy: false });
  if (!wall.supported) {
    log('inline-3D not supported here (not the DisplayXR Browser?) — nothing to track.');
    showGate('unknown');
    return;
  }
  const watch = watchHands(wall, onHands, {
    onChange: (e) => {
      for (const s of e.added) log(`inputsourceschange ADDED ${s.handedness} ${s.targetRayMode} joints=${s.hand.size} profiles=${s.profiles.join(',')}`);
      for (const s of e.removed) log(`inputsourceschange REMOVED ${s.handedness}`);
    },
  });
  log(`session up · XRHand ${watch.state.supported ? 'present' : 'ABSENT in this browser'} · put a hand over the tracker`);
  wall.addScene(canvas, onFrame, { virtualDisplayHeight: VDH });
  addEventListener('pagehide', () => {
    watch.stop();
    wall.close();
  });
};

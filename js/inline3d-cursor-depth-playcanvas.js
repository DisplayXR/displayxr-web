// inline3d-cursor-depth-playcanvas.js — the depth-aware cursor on the PlayCanvas backend (./model and
// ./splat, `cursor: 'depth'`).
//
// Internal, and LOADED ONLY ON OPT-IN: the adapters import this module dynamically when a page
// passes `cursor: 'depth'`, so a page that does not ask pays nothing — not even the download.
// The adapter's per-frame hook is an optional call (`viewer.cursorDepth?.frame(…)`) that is a
// no-op without it.
//
// Hit test: PlayCanvas's own depth PICKER, from the first eye, at low resolution. One path for
// meshes AND gaussian splats (the picker renders both into its depth target), and it reads what
// is actually drawn — no splat raycasting, no CPU triangle walk. It costs one extra low-res
// scene pass, run every other frame and only while the pointer is over the canvas. Results come
// back asynchronously (a frame or two late); the placement filter absorbs that, exactly like the
// runtime's one-frame-late app hint.
//
// Placement: the same maths as everywhere else (./inline3d-cursor-depth.js, a port of the
// runtime's u_cursor_depth, ADR-046), solved in WORLD space from this frame's views carried
// through the rig node. Drawn as a filled mesh (strokes + a dark outline) in the UI layer with
// depth test off, so every eye camera draws it last and nothing occludes it; the picker skips the
// UI layer, so the cursor never picks itself.

import {
  CursorDepthPlacer,
  CursorPointer,
  CURSOR_DEFAULT_HEIGHT,
  CURSOR_DEFAULT_TUNING,
  cursorCrosshairMesh,
  cursorFootprint,
  cursorViewRay,
} from './inline3d-cursor-depth.js';

/** Pick-buffer width in pixels (height follows the eye's aspect). */
const PICK_WIDTH = 160;
/** Pick every Nth frame. */
const PICK_EVERY = 2;
/** A pick that has not answered in this long is abandoned (and the cursor falls to the glass). */
const PICK_TIMEOUT_MS = 500;

export class PlayCanvasDepthCursor {
  /**
   * @param {object} pc  the PlayCanvas namespace the adapter renders with.
   * @param {object} viewer  the PlayCanvasSplatViewer (app, rigNode, eye are read lazily).
   * @param {{canvas: HTMLElement, height?: number, margin?: number, anchor?: string, pointerScope?: string}} opts
   */
  constructor(pc, viewer, { canvas, height = CURSOR_DEFAULT_HEIGHT, margin, anchor = 'hybrid', pointerScope = 'canvas' }) {
    this.pc = pc;
    this.viewer = viewer;
    this.height = height > 0 && Number.isFinite(height) ? height : CURSOR_DEFAULT_HEIGHT;
    this.pointer = new CursorPointer(canvas, { scope: pointerScope });
    const tuning = margin > 0 && Number.isFinite(margin) ? { ...CURSOR_DEFAULT_TUNING, margin } : CURSOR_DEFAULT_TUNING;
    this.placer = new CursorDepthPlacer(tuning, { anchor });
    /** The last placement (diagnostics). */
    this.placement = { active: false };
    /** The last picked world point under the footprint, or null (nothing under it). */
    this.hit = null;
    this._picker = null;
    this._pickCam = null;
    this._inFlight = false;
    this._pickId = 0;
    this._pickStart = 0;
    this._frame = 0;
    this._disposed = false;
    this._sprite = null; // { mi, node, mat } — built on first use
  }

  /**
   * One 3D frame, before app.tick: schedule a pick, place the sprite, queue its lines.
   * @param {Array<{proj: ArrayLike<number>, pose: ArrayLike<number>, width: number, height: number}>} entries
   *        this frame's views, poses in RIG space (the eye cameras' parent).
   */
  frame(entries) {
    const app = this.viewer.app;
    const rig = this.viewer.rigNode;
    const uv = this.pointer.uv;
    if (this._disposed || !app || !rig || !uv || !entries || entries.length < 2) {
      this.inactive();
      return;
    }
    const R = rig.getWorldTransform().data;
    const views = entries.map((e) => ({ projectionMatrix: e.proj, transformMatrix: mul4(R, e.pose) }));
    const t = globalThis.performance ? globalThis.performance.now() : Date.now();
    if (this._inFlight && t - this._pickStart > PICK_TIMEOUT_MS) {
      // A read that never settles must not freeze the cursor on a stale hit.
      this._inFlight = false;
      this._pickId++;
      this.hit = null;
      if (!this._warnedTimeout) {
        this._warnedTimeout = true;
        console.warn('[inline3d] cursor: depth: a PlayCanvas pick did not answer in time; retrying (cursor on the glass meanwhile).');
      }
    }
    if (this._frame++ % PICK_EVERY === 0 && !this._inFlight) this._pick(app, rig, entries[0], uv);
    const now = (globalThis.performance ? globalThis.performance.now() : Date.now()) / 1000;
    const p = this.placer.update(views, { u: uv[0], v: uv[1], nearestPoint: this.hit, cursorHeight: this.height }, now);
    this.placement = p;
    this.pointer.hideCss(!!p.active);
    const sprite = this._sprite || (p.active ? this._makeSprite(app) : null);
    if (!sprite) return;
    sprite.mi.visible = !!p.active;
    if (!p.active) return;
    // The unit crosshair in the sprite's XY plane: basis (rotation), height (scale), position.
    const { x, y, z } = p.basis;
    const q = quatFromMatrix([x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, 0, 0, 0, 1]);
    sprite.node.setLocalPosition(p.position[0], p.position[1], p.position[2]);
    sprite.node.setLocalRotation(q[0], q[1], q[2], q[3]);
    sprite.node.setLocalScale(p.height, p.height, p.height);
  }

  /** Mono / no pointer / no views: no sprite, the CSS cursor back. */
  inactive() {
    if (this.placement.active) this.placement = { active: false };
    this.placer.update(null); // forget the hybrid anchor
    if (this._sprite) this._sprite.mi.visible = false;
    this.pointer.hideCss(false);
  }

  // The filled crosshair: one mesh (outline triangles first, fill after — the order a
  // depth-test-off draw needs), vertex-coloured, alpha-blended, in the UI layer.
  _makeSprite(app) {
    const pc = this.pc;
    const m = cursorCrosshairMesh();
    const mesh = new pc.Mesh(app.graphicsDevice);
    mesh.setPositions(m.positions);
    mesh.setColors(m.colors);
    mesh.update();
    const mat = new pc.ShaderMaterial({
      uniqueName: 'inline3dDepthCursor',
      attributes: { vertex_position: pc.SEMANTIC_POSITION, vertex_color: pc.SEMANTIC_COLOR },
      vertexGLSL: `
        attribute vec3 vertex_position;
        attribute vec4 vertex_color;
        uniform mat4 matrix_model;
        uniform mat4 matrix_viewProjection;
        varying vec4 vColor;
        void main() { vColor = vertex_color; gl_Position = matrix_viewProjection * matrix_model * vec4(vertex_position, 1.0); }`,
      fragmentGLSL: `
        varying vec4 vColor;
        void main() { gl_FragColor = vColor; }`,
    });
    mat.blendState = new pc.BlendState(
      true,
      pc.BLENDEQUATION_ADD,
      pc.BLENDMODE_SRC_ALPHA,
      pc.BLENDMODE_ONE_MINUS_SRC_ALPHA,
      pc.BLENDEQUATION_ADD,
      pc.BLENDMODE_ONE,
      pc.BLENDMODE_ONE_MINUS_SRC_ALPHA,
    );
    mat.depthTest = false;
    mat.depthWrite = false;
    mat.cull = pc.CULLFACE_NONE;
    mat.update();
    const node = new pc.GraphNode('inline3d-cursor');
    app.root.addChild(node); // world space = the views' (rig-carried) space
    const mi = new pc.MeshInstance(mesh, mat, node);
    mi.cull = false;
    mi.pick = false;
    mi.drawOrder = 1e9;
    app.scene.layers.getLayerById(pc.LAYERID_UI).addMeshInstances([mi]);
    this._sprite = { mi, node, mat };
    return this._sprite;
  }

  dispose() {
    this._disposed = true;
    this.pointer.dispose();
    try {
      if (this._sprite) {
        this.viewer.app?.scene?.layers?.getLayerById(this.pc.LAYERID_UI)?.removeMeshInstances?.([this._sprite.mi]);
        this._sprite.node.destroy?.();
      }
      this._picker?.destroy?.();
      this._pickCam?.destroy?.();
    } catch {
      // the app may already be gone with its device
    }
    this._picker = null;
    this._pickCam = null;
  }

  // Render the pick buffer from the first eye and read the footprint's world points.
  _pick(app, rig, e, uv) {
    const pc = this.pc;
    const aspect = e.width > 0 && e.height > 0 ? e.width / e.height : 1;
    const W = PICK_WIDTH;
    const H = Math.max(1, Math.round(W / aspect));
    if (!this._picker) {
      this._picker = new pc.Picker(app, W, H, true);
      const cam = new pc.Entity('inline3d-cursor-pick', app);
      // frustumCulling off: this camera never renders on its own (disabled — the picker drives
      // it), so nothing keeps its culling frustum current, and a stale one culls everything.
      cam.addComponent('camera', { clearColor: new pc.Color(0, 0, 0, 0), frustumCulling: false });
      cam.camera.enabled = false;
      cam._dxrProj = new Float64Array(16);
      cam.camera.calculateProjection = (out) => out.set(cam._dxrProj);
      rig.addChild(cam);
      this._pickCam = cam;
    }
    const cam = this._pickCam;
    cam._dxrProj.set(e.proj);
    // The picker linearises depth with the COMPONENT's near/far, and reconstructs through the
    // projection: keep the two in agreement (GL-style projection: m10 = -(f+n)/(f-n), m14 = -2fn/(f-n)).
    const m10 = e.proj[10], m14 = e.proj[14];
    const near = m14 / (m10 - 1);
    const far = m14 / (m10 + 1);
    if (near > 0 && far > near) {
      cam.camera.nearClip = near;
      cam.camera.farClip = far;
    }
    if (cam.camera.camera) cam.camera.camera._projMatDirty = true;
    const q = quatFromMatrix(e.pose);
    cam.setLocalPosition(e.pose[12], e.pose[13], e.pose[14]);
    cam.setLocalRotation(q[0], q[1], q[2], q[3]);
    const eye = this.viewer.eye?.camera;
    const skip = new Set([pc.LAYERID_UI, pc.LAYERID_IMMEDIATE, pc.LAYERID_SKYBOX]);
    const ids = (eye && Array.isArray(eye.layers) ? eye.layers : cam.camera.layers).filter((id) => !skip.has(id));
    const layers = ids.map((id) => app.scene.layers.getLayerById(id)).filter(Boolean);

    const picker = this._picker;
    picker.resize(W, H);
    try {
      // Enabled only for the synchronous pick pass: a disabled camera is not in its layers'
      // camera lists, so the picker would render nothing; enabled outside it, the camera would
      // render a frame of its own on every app.tick.
      cam.camera.enabled = true;
      picker.prepare(cam.camera, app.scene, layers);
    } catch (err) {
      console.warn('[inline3d] cursor: depth: the PlayCanvas picker failed; cursor stays on the glass.', err);
      this.hit = null;
      return;
    } finally {
      cam.camera.enabled = false;
    }
    // The picker stores LINEAR depth: (viewDist - near) / (far - near), viewDist = 1/gl_FragCoord.w.
    // Rebuild the point ourselves along the exact off-axis ray (getWorldPointAsync would unproject
    // with the component's symmetric projection, not this one). PlayCanvas's view matrix is built
    // from the camera's world POSITION and ROTATION only — the rig node's scale is not in it — so
    // view distances are world units and the ray must use the UNSCALED world rotation.
    const view = { projectionMatrix: e.proj, transformMatrix: unscaled(cam.getWorldTransform().data) };
    const Mw = view.transformMatrix;
    const f = [-Mw[8], -Mw[9], -Mw[10]];
    const zNear = cam.camera.nearClip, zFar = cam.camera.farClip;
    const samples = cursorFootprint(uv[0], uv[1], this.height, this.pointer.aspect())
      .filter(([u, v]) => u >= 0 && u <= 1 && v >= 0 && v <= 1)
      .map(([u, v]) =>
        picker.getPointDepthAsync(Math.min(W - 1, Math.floor(u * W)), Math.min(H - 1, Math.floor(v * H))).then((lin) => {
          if (lin === null || !(lin >= 0 && lin < 1)) return null;
          const z = zNear + lin * (zFar - zNear);
          const ray = cursorViewRay(view, u, v);
          return { x: ray.origin[0] + ray.direction[0] * z, y: ray.origin[1] + ray.direction[1] * z, z: ray.origin[2] + ray.direction[2] * z };
        }),
      );
    this._inFlight = true;
    const id = ++this._pickId;
    this._pickStart = globalThis.performance ? globalThis.performance.now() : Date.now();
    Promise.all(samples)
      .then((pts) => {
        if (this._disposed || id !== this._pickId) return;
        let best = Infinity;
        let nearest = null;
        for (const p of pts) {
          if (!p) continue;
          const d = p.x * f[0] + p.y * f[1] + p.z * f[2];
          if (d < best) {
            best = d;
            nearest = [p.x, p.y, p.z];
          }
        }
        this.hit = nearest;
      })
      .catch(() => {
        if (id === this._pickId) this.hit = null;
      })
      .finally(() => {
        if (id === this._pickId) this._inFlight = false;
      });
  }
}

/** A copy of a column-major transform with unit rotation columns (scale removed). */
function unscaled(m) {
  const o = Array.from(m);
  for (const c of [0, 4, 8]) {
    const l = Math.hypot(o[c], o[c + 1], o[c + 2]) || 1;
    o[c] /= l;
    o[c + 1] /= l;
    o[c + 2] /= l;
  }
  return o;
}

/** Column-major 4x4 multiply, a × b. */
function mul4(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

/** Unit quaternion [x, y, z, w] from a column-major rigid transform's rotation. */
function quatFromMatrix(m) {
  const m00 = m[0], m11 = m[5], m22 = m[10];
  const tr = m00 + m11 + m22;
  let x, y, z, w;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s;
    x = (m[6] - m[9]) / s;
    y = (m[8] - m[2]) / s;
    z = (m[1] - m[4]) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m[6] - m[9]) / s;
    x = 0.25 * s;
    y = (m[4] + m[1]) / s;
    z = (m[8] + m[2]) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m[8] - m[2]) / s;
    x = (m[4] + m[1]) / s;
    y = 0.25 * s;
    z = (m[9] + m[6]) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m[1] - m[4]) / s;
    x = (m[8] + m[2]) / s;
    y = (m[9] + m[6]) / s;
    z = 0.25 * s;
  }
  const l = Math.hypot(x, y, z, w) || 1;
  return [x / l, y / l, z / l, w / l];
}

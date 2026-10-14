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
// runtime's u_cursor_depth, ADR-046 + Amendment 2's policy), solved in WORLD space from this
// frame's views carried through the rig node. Drawn — only while content under it comes out of the
// glass — as the classic arrow (the shared cursorArrowMesh: dark outline, white fill, tip on the
// hotspot) in the UI layer with depth test off, so every eye camera draws it last and nothing
// occludes it; the picker skips the UI layer, so the cursor never picks itself. On the plane
// nothing is drawn and the CSS cursor is the cursor. A LIFTED arrow is softened against crosstalk
// (ADR-046 Amendment 2 §B.7): the mesh instance swaps to a quad whose shader blurs and fades the
// arrow (cursorSoftArrowGLSL); a (0 px, 1.0) frame draws the crisp mesh exactly as before.

import {
  CursorDepthPlacer,
  CursorPointer,
  CURSOR_DEFAULT_TUNING,
  cursorArrowFootprint,
  cursorDefaultHeight,
  cursorPlacementSoften,
  cursorArrowMesh,
  cursorSoftArrowBox,
  cursorSoftArrowGLSL,
  CursorShapeSelector,
  cursorShapeTexture,
  cursorSpriteBox,
  cursorSpriteGLSL,
  cursorSpriteRect,
  cursorViewRay,
  resolveCursorSoften,
  CURSOR_FILL_COLOR,
  CURSOR_OUTLINE_COLOR,
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
   * @param {{canvas: HTMLElement, height?: number, margin?: number, anchor?: string, pointerScope?: string, soften?: string|object, shape?: string, shapeFor?: Function}} opts
   */
  constructor(pc, viewer, { canvas, height, margin, anchor = 'hybrid', pointerScope = 'canvas', soften, shape = 'auto', shapeFor = null }) {
    this.pc = pc;
    this.viewer = viewer;
    /** Sprite height (canvas heights) when set; null = the OS arrow's size, from the canvas's on-page height. */
    this.height = height > 0 && Number.isFinite(height) ? height : null;
    this.pointer = new CursorPointer(canvas, { scope: pointerScope });
    const tuning = margin > 0 && Number.isFinite(margin) ? { ...CURSOR_DEFAULT_TUNING, margin } : CURSOR_DEFAULT_TUNING;
    this.placer = new CursorDepthPlacer(tuning, { anchor });
    /** The last placement (diagnostics). */
    this.placement = { active: false };
    /** Crosstalk softening parameters (resolveCursorSoften). */
    this.soften = resolveCursorSoften(soften, '@displayxr/inline3d cursor');
    /** The last frame's softening (diagnostics), null while nothing is drawn. */
    this.softening = null;
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
    /** Which sprite (CSS mirror / fixed / shapeFor); `.current` = the one drawn last. */
    this.shapes = new CursorShapeSelector(this.pointer, { shape, shapeFor });
  }

  /** The sprite drawn last: a CURSOR_SHAPES name, 'none' or 'image'. */
  get shape() {
    return this.shapes.current;
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
    const h = this.height ?? cursorDefaultHeight(this.pointer.cssHeight());
    if (this._frame++ % PICK_EVERY === 0 && !this._inFlight) this._pick(app, rig, entries[0], uv, h);
    const now = (globalThis.performance ? globalThis.performance.now() : Date.now()) / 1000;
    const p = this.placer.update(views, { u: uv[0], v: uv[1], nearestPoint: this.hit, cursorHeight: h, canvasPx: this.pointer.panelPx() }, now);
    this.placement = p;
    this.pointer.hideCss(!!p.active);
    const sprite = this._sprite || (p.active ? this._makeSprite(app) : null);
    this.softening = null;
    if (!sprite) return;
    sprite.mi.visible = !!p.active;
    if (!p.active) return;
    const [pw, ph] = this.pointer.panelSize();
    const s = (this.softening = cursorPlacementSoften(p, views, pw, ph, h, this.soften));
    const chosen = this.shapes.pick({ u: uv[0], v: uv[1], point: this.hit }, t);
    if (chosen.kind === 'none') sprite.mi.visible = false; // the page hides its cursor: so do we (the OS one stays hidden)
    else if (chosen.kind === 'shape' && chosen.name === 'arrow') this._useSoft(app, sprite, s);
    else this._useSprite(app, sprite, s, chosen);
    // The unit arrow in the sprite's XY plane, tip at its origin: basis (rotation), height (scale), position = the hotspot.
    const { x, y, z } = p.basis;
    const q = quatFromMatrix([x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, 0, 0, 0, 1]);
    sprite.node.setLocalPosition(p.position[0], p.position[1], p.position[2]);
    sprite.node.setLocalRotation(q[0], q[1], q[2], q[3]);
    sprite.node.setLocalScale(p.height, p.height, p.height);
  }

  /** Mono / no pointer / no views: no sprite, the CSS cursor back. */
  inactive() {
    if (this.placement.active) this.placement = { active: false };
    this.softening = null;
    this.placer.update(null); // forget the hybrid anchor
    if (this._sprite) this._sprite.mi.visible = false;
    this.pointer.hideCss(false);
  }

  // The arrow: one mesh (outline triangles first, fill after — the order a depth-test-off draw
  // needs), vertex-coloured, alpha-blended, in the UI layer.
  _makeSprite(app) {
    const pc = this.pc;
    const m = cursorArrowMesh();
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
    this._sprite = { mi, node, mat, mesh, soft: null, tex: null, textures: new Map() };
    return this._sprite;
  }

  // Crisp: the arrow mesh and material as built above. Softened: a quad over the padded arrow box,
  // its shader the runtime's 13-tap blur of the arrow, times the opacity.
  _useSoft(app, sprite, s) {
    const mi = sprite.mi;
    if (!s.soft) {
      if (mi.mesh !== sprite.mesh) mi.mesh = sprite.mesh;
      if (mi.material !== sprite.mat) mi.material = sprite.mat;
      return;
    }
    const soft = sprite.soft || (sprite.soft = this._makeSoft(app));
    soft.mat.setParameter('inline3dCursorBox', cursorSoftArrowBox(s.radius, s.aa));
    soft.mat.setParameter('inline3dCursorSoft', [s.radius, s.alpha, s.aa, 0]);
    if (mi.mesh !== soft.mesh) mi.mesh = soft.mesh;
    if (mi.material !== soft.mat) mi.material = soft.mat;
  }

  _makeSoft(app) {
    const pc = this.pc;
    const mesh = new pc.Mesh(app.graphicsDevice);
    // A unit quad; the vertex shader spreads it over the padded arrow box (arrow units, y down).
    mesh.setPositions(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]));
    mesh.update();
    const mat = new pc.ShaderMaterial({
      uniqueName: 'inline3dDepthCursorSoft',
      attributes: { vertex_position: pc.SEMANTIC_POSITION },
      vertexGLSL: `
        attribute vec3 vertex_position;
        uniform mat4 matrix_model;
        uniform mat4 matrix_viewProjection;
        uniform vec4 inline3dCursorBox;
        varying vec2 vArrow;
        void main() {
          vArrow = vec2(mix(inline3dCursorBox.x, inline3dCursorBox.z, vertex_position.x), mix(inline3dCursorBox.y, inline3dCursorBox.w, vertex_position.y));
          gl_Position = matrix_viewProjection * matrix_model * vec4(vArrow.x, -vArrow.y, 0.0, 1.0);
        }`,
      fragmentGLSL: `
        uniform vec4 inline3dCursorSoft; // radius, opacity, aa (arrow units)
        uniform vec3 inline3dCursorFill;
        uniform vec3 inline3dCursorOutline;
        varying vec2 vArrow;
        ${cursorSoftArrowGLSL()}
        void main() {
          vec4 c = inline3dSoftArrow(vArrow, inline3dCursorSoft.x, inline3dCursorSoft.z, inline3dCursorFill, inline3dCursorOutline);
          gl_FragColor = vec4(c.rgb, c.a * inline3dCursorSoft.y);
        }`,
    });
    mat.setParameter('inline3dCursorFill', CURSOR_FILL_COLOR.slice(0, 3));
    mat.setParameter('inline3dCursorOutline', CURSOR_OUTLINE_COLOR.slice(0, 3));
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
    return { mesh, mat };
  }

  // Every sprite but the arrow: a texture (a keyword shape rasterised once, or a url() image) on
  // one soft quad — the same 13-tap blur and opacity, crisp at radius 0. One program for all.
  _useSprite(app, sprite, s, chosen) {
    const mi = sprite.mi;
    const q = sprite.tex || (sprite.tex = this._makeTex(app));
    const radius = s.soft ? s.radius : 0;
    q.mat.setParameter('inline3dCursorTex', this._texture(app, sprite, chosen));
    q.mat.setParameter('inline3dCursorBox', cursorSpriteBox(chosen, radius, s.aa));
    q.mat.setParameter('inline3dCursorRect', cursorSpriteRect(chosen));
    q.mat.setParameter('inline3dCursorSoft', [radius, s.soft ? s.alpha : 1, 0, 0]);
    if (mi.mesh !== q.mesh) mi.mesh = q.mesh;
    if (mi.material !== q.mat) mi.material = q.mat;
  }

  _texture(app, sprite, chosen) {
    let t = sprite.textures.get(chosen.key);
    if (t) return t;
    const pc = this.pc;
    const opts = {
      name: `inline3d-cursor-${chosen.kind}`,
      format: pc.PIXELFORMAT_RGBA8,
      mipmaps: false,
      minFilter: pc.FILTER_LINEAR,
      magFilter: pc.FILTER_LINEAR,
      addressU: pc.ADDRESS_CLAMP_TO_EDGE,
      addressV: pc.ADDRESS_CLAMP_TO_EDGE,
      flipY: false, // row 0 = the sprite's top, as the shader reads it
    };
    if (chosen.kind === 'image') {
      const img = chosen.entry.image;
      t = new pc.Texture(app.graphicsDevice, { ...opts, width: img.naturalWidth || img.width, height: img.naturalHeight || img.height });
      t.setSource(img);
    } else {
      const d = cursorShapeTexture(chosen.name);
      t = new pc.Texture(app.graphicsDevice, { ...opts, width: d.width, height: d.height });
      t.lock().set(d.data);
      t.unlock();
    }
    if (sprite.textures.size > 32) {
      for (const old of sprite.textures.values()) old.destroy?.();
      sprite.textures.clear();
    }
    sprite.textures.set(chosen.key, t);
    return t;
  }

  _makeTex(app) {
    const pc = this.pc;
    const mesh = new pc.Mesh(app.graphicsDevice);
    mesh.setPositions(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]));
    mesh.update();
    const mat = new pc.ShaderMaterial({
      uniqueName: 'inline3dDepthCursorSprite',
      attributes: { vertex_position: pc.SEMANTIC_POSITION },
      vertexGLSL: `
        attribute vec3 vertex_position;
        uniform mat4 matrix_model;
        uniform mat4 matrix_viewProjection;
        uniform vec4 inline3dCursorBox;
        varying vec2 vSprite;
        void main() {
          vSprite = vec2(mix(inline3dCursorBox.x, inline3dCursorBox.z, vertex_position.x), mix(inline3dCursorBox.y, inline3dCursorBox.w, vertex_position.y));
          gl_Position = matrix_viewProjection * matrix_model * vec4(vSprite.x, -vSprite.y, 0.0, 1.0);
        }`,
      fragmentGLSL: `
        uniform vec4 inline3dCursorRect; // the area the texture covers (sprite units, y down)
        uniform vec4 inline3dCursorSoft; // radius (sprite units), opacity
        uniform sampler2D inline3dCursorTex;
        varying vec2 vSprite;
        ${cursorSpriteGLSL()}
        void main() {
          vec4 c = inline3dSoftSprite(inline3dCursorTex, vSprite, inline3dCursorRect, inline3dCursorSoft.x);
          gl_FragColor = vec4(c.rgb, c.a * inline3dCursorSoft.y);
        }`,
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
    return { mesh, mat };
  }

  dispose() {
    this._disposed = true;
    this.pointer.dispose();
    this.shapes.dispose();
    try {
      if (this._sprite) {
        this.viewer.app?.scene?.layers?.getLayerById(this.pc.LAYERID_UI)?.removeMeshInstances?.([this._sprite.mi]);
        this._sprite.node.destroy?.();
        this._sprite.soft?.mat.destroy?.();
        this._sprite.soft?.mesh.destroy?.();
        this._sprite.tex?.mat.destroy?.();
        this._sprite.tex?.mesh.destroy?.();
        for (const t of this._sprite.textures.values()) t.destroy?.();
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
  _pick(app, rig, e, uv, height) {
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
    // The depth picker draws into TWO colour targets (pick id + pick depth). The engine's lit and
    // gsplat shaders write both under DEPTH_PICK_PASS; an app's own pc.ShaderMaterial usually
    // writes only the first, and WebGL rejects every such draw with GL_INVALID_OPERATION ("Active
    // draw buffers with missing fragment shader outputs") — one per mesh per pick, so a page with
    // a custom-shader backdrop logged hundreds a second. Those draws never reached the pick buffer
    // anyway: leave them out of the pass, exactly as if they were not pickable.
    const muted = muteDepthlessPicks(pc, layers, app.graphicsDevice);
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
      for (const mi of muted) mi.pick = true;
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
    const samples = cursorArrowFootprint(uv[0], uv[1], height, this.pointer.aspect())
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
// Does this material's pick shader write the depth-pick output (the second colour target)? Engine
// materials do; a pc.ShaderMaterial does when its fragment code, with its #includes followed
// through the material's and the engine's chunk maps, handles DEPTH_PICK_PASS — the engine's own
// gsplat material is a ShaderMaterial whose whole fragment is `#include "gsplatPS"`.
const writesPickDepth = new WeakMap();
const PICK_DEPTH_RE = /DEPTH_PICK_PASS|pcFragColor1/;
function materialWritesPickDepth(pc, mat, device) {
  if (!mat || !pc.ShaderMaterial || !(mat instanceof pc.ShaderMaterial)) return true;
  let v = writesPickDepth.get(mat);
  if (v !== undefined) return v;
  v = true; // can't tell: leave it in the pass, as before
  try {
    const wgsl = !!device?.isWebGPU;
    const d = mat.shaderDesc || {};
    const root = wgsl ? d.fragmentWGSL : d.fragmentGLSL ?? d.fragmentCode;
    if (typeof root === 'string') {
      const lang = wgsl ? pc.SHADERLANGUAGE_WGSL : pc.SHADERLANGUAGE_GLSL;
      const own = mat.hasShaderChunks ? (wgsl ? mat.shaderChunks.wgsl : mat.shaderChunks.glsl) : null;
      const engine = pc.ShaderChunks?.get ? pc.ShaderChunks.get(device, lang) : null;
      const chunk = (name) => own?.get?.(name) ?? engine?.get?.(name);
      const seen = new Set();
      const scan = (code, depth) => {
        if (PICK_DEPTH_RE.test(code)) return true;
        if (depth > 8) return false;
        for (const [, name] of code.matchAll(/#include\s+"(\w+)"/g)) {
          if (seen.has(name)) continue;
          seen.add(name);
          const c = chunk(name);
          if (typeof c === 'string' && scan(c, depth + 1)) return true;
        }
        return false;
      };
      v = scan(root, 0);
    }
  } catch {
    v = true;
  }
  writesPickDepth.set(mat, v);
  return v;
}

// Clear `pick` on the layers' mesh instances whose shader cannot write pick depth; returns them so
// the caller restores the flag right after the (synchronous) pick pass.
function muteDepthlessPicks(pc, layers, device) {
  const muted = [];
  for (const layer of layers) {
    for (const mi of layer.meshInstances || []) {
      if (mi.pick && !materialWritesPickDepth(pc, mi.material, device)) {
        mi.pick = false;
        muted.push(mi);
      }
    }
  }
  return muted;
}

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

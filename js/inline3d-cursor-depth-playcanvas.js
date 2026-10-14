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
    this._picker2 = null; // the display-rig pass (handle.setLayerRig), made on first use
    this._pickCam2 = null;
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
      this._picker2?.destroy?.();
      this._pickCam2?.destroy?.();
    } catch {
      // the app may already be gone with its device
    }
    this._picker = null;
    this._pickCam = null;
    this._picker2 = null;
    this._pickCam2 = null;
  }

  // Render the pick buffer from the first eye and read the footprint's world points. Layers moved
  // to the display rig (handle.setLayerRig) are drawn by the layer rig's own cameras, not the eye:
  // with the rig ROUNDED (a camera rig, gain != 1) they take a second pass through the round
  // views, and each of their hits becomes the world point the PHOTO views see at the same pixels
  // in both eyes, so the placer (which solves against the photo views) puts the arrow where the
  // stage appears. Otherwise they draw through the photo views and simply join the eye pass.
  _pick(app, rig, e, uv, height) {
    const pc = this.pc;
    const aspect = e.width > 0 && e.height > 0 ? e.width / e.height : 1;
    const W = PICK_WIDTH;
    const H = Math.max(1, Math.round(W / aspect));
    if (!this._picker) {
      this._picker = new pc.Picker(app, W, H, true);
      this._pickCam = this._makePickCam(app, rig, 'inline3d-cursor-pick');
    }
    const cam = this._pickCam;
    // The picker linearises depth with the COMPONENT's near/far, and reconstructs through the
    // projection: keep the two in agreement (GL-style projection: m10 = -(f+n)/(f-n), m14 = -2fn/(f-n)).
    const m10 = e.proj[10], m14 = e.proj[14];
    const near = m14 / (m10 - 1);
    const far = m14 / (m10 + 1);
    placePickCam(cam, e.proj, e.pose, near, far);
    const eye = this.viewer.eye?.camera;
    const plan = cursorPickPlan(
      eye && Array.isArray(eye.layers) ? eye.layers : cam.camera.layers,
      this.viewer.layerRigs,
      [pc.LAYERID_UI, pc.LAYERID_IMMEDIATE, pc.LAYERID_SKYBOX],
    );
    const layers = plan.eye.map((id) => app.scene.layers.getLayerById(id)).filter(Boolean);
    setCamLayers(cam, plan.eye);

    const picker = this._picker;
    picker.resize(W, H);
    if (!this._prepare(picker, cam, app, layers)) return;
    // The picker stores LINEAR depth: (viewDist - near) / (far - near), viewDist = 1/gl_FragCoord.w.
    // Rebuild the point ourselves along the exact off-axis ray (getWorldPointAsync would unproject
    // with the component's symmetric projection, not this one). PlayCanvas's view matrix is built
    // from the camera's world POSITION and ROTATION only — the rig node's scale is not in it — so
    // view distances are world units and the ray must use the UNSCALED world rotation.
    const view = { projectionMatrix: e.proj, transformMatrix: unscaled(cam.getWorldTransform().data) };
    const Mw = view.transformMatrix;
    const f = [-Mw[8], -Mw[9], -Mw[10]];
    const zNear = cam.camera.nearClip, zFar = cam.camera.farClip;
    const footprint = cursorArrowFootprint(uv[0], uv[1], height, this.pointer.aspect()).filter(([u, v]) => u >= 0 && u <= 1 && v >= 0 && v <= 1);
    const read = (pk, u, v, toWorld) =>
      pk.getPointDepthAsync(Math.min(W - 1, Math.floor(u * W)), Math.min(H - 1, Math.floor(v * H))).then((lin) => {
        if (lin === null || !(lin >= 0 && lin < 1)) return null;
        return toWorld(u, v, zNear + lin * (zFar - zNear));
      });
    const samples = footprint.map(([u, v]) =>
      read(picker, u, v, (uu, vv, z) => {
        const ray = cursorViewRay(view, uu, vv);
        return { x: ray.origin[0] + ray.direction[0] * z, y: ray.origin[1] + ray.direction[1] * z, z: ray.origin[2] + ray.direction[2] * z };
      }),
    );
    // The display run, rounded: a second pass, only while such a layer exists (zero cost otherwise).
    if (plan.display.length) {
      const lr = this.viewer.layerRigs;
      const pass = this._pickDisplay(app, rig, e, lr, plan.display, near, far, W, H);
      if (pass) for (const [u, v] of footprint) samples.push(read(pass.picker, u, v, pass.toWorld));
    }
    this._inFlight = true;
    const id = ++this._pickId;
    this._pickStart = globalThis.performance ? globalThis.performance.now() : Date.now();
    Promise.all(samples)
      .then((pts) => {
        if (this._disposed || id !== this._pickId) return;
        this.hit = nearestPickPoint(pts, f);
      })
      .catch(() => {
        if (id === this._pickId) this.hit = null;
      })
      .finally(() => {
        if (id === this._pickId) this._inFlight = false;
      });
  }

  // The pick camera: a child of the rig node, DISABLED except around prepare() (a disabled camera
  // is in no layer's camera list, so the picker would render nothing; an enabled one would render
  // a frame of its own on every app.tick), with a projection override.
  _makePickCam(app, rig, name) {
    const pc = this.pc;
    const cam = new pc.Entity(name, app);
    // frustumCulling off: this camera never renders on its own, so nothing keeps its culling
    // frustum current, and a stale one culls everything.
    cam.addComponent('camera', { clearColor: new pc.Color(0, 0, 0, 0), frustumCulling: false });
    cam.camera.enabled = false;
    cam._dxrProj = new Float64Array(16);
    cam.camera.calculateProjection = (out) => out.set(cam._dxrProj);
    rig.addChild(cam);
    return cam;
  }

  // One synchronous pick pass. The depth picker draws into TWO colour targets (pick id + pick
  // depth). The engine's lit and gsplat shaders write both under DEPTH_PICK_PASS; an app's own
  // pc.ShaderMaterial usually writes only the first, and WebGL rejects every such draw with
  // GL_INVALID_OPERATION ("Active draw buffers with missing fragment shader outputs") — one per
  // mesh per pick, so a page with a custom-shader backdrop logged hundreds a second. Those draws
  // never reached the pick buffer anyway: leave them out of the pass, exactly as if they were not
  // pickable. (A ShaderMaterial opts in with CURSOR_DEPTH_PICK_GLSL / _WGSL.)
  _prepare(picker, cam, app, layers) {
    const muted = muteDepthlessPicks(this.pc, layers, app.graphicsDevice);
    try {
      cam.camera.enabled = true;
      picker.prepare(cam.camera, app.scene, layers);
      return true;
    } catch (err) {
      console.warn('[inline3d] cursor: depth: the PlayCanvas picker failed; cursor stays on the glass.', err);
      this.hit = null;
      return false;
    } finally {
      cam.camera.enabled = false;
      for (const mi of muted) mi.pick = true;
    }
  }

  // The display-rig pass: its own picker + camera, drawn with exactly what the layer rig's display
  // camera draws, proj · view_round · rig⁻¹ (PlayCanvas composes RenderViews with the rig node's
  // world transform, scale included). The camera's own view is undone in the projection override,
  // as the layer rig's N-camera path does. Null (no pass) when the rig has no round views this frame.
  _pickDisplay(app, rig, e, lr, ids, near, far, W, H) {
    const round = lr?.lastRound;
    const poses = lr?.lastEntries;
    if (!round || !poses || round.length < 2 || poses.length !== round.length) return null;
    const pc = this.pc;
    if (!this._picker2) {
      this._picker2 = new pc.Picker(app, W, H, true);
      this._pickCam2 = this._makePickCam(app, rig, 'inline3d-cursor-pick-display');
    }
    const cam = this._pickCam2;
    placePickCam(cam, e.proj, e.pose, near, far);
    const R = rig.getWorldTransform().data;
    const Rinv = invert4(R);
    if (!Rinv) return null;
    cam._dxrProj.set(mul4(e.proj, mul4(round[0].view, mul4(Rinv, unscaled(cam.getWorldTransform().data)))));
    if (cam.camera.camera) cam.camera.camera._projMatDirty = true;
    setCamLayers(cam, ids);
    const layers = ids.map((id) => app.scene.layers.getLayerById(id)).filter(Boolean);
    const picker = this._picker2;
    picker.resize(W, H);
    if (!this._prepare(picker, cam, app, layers)) return null;
    const solve = displayRigPickSolver(e.proj, round, poses.map((p) => p.pose), R);
    if (!solve) return null;
    return { picker, toWorld: (u, v, dist) => solve(u, v, dist) };
  }
}

/**
 * Which layers each pick pass draws. `eyeLayers` the eye camera's list; `layerRigs` the viewer's
 * LayerRigCameras (or null); `skip` the ids never picked (UI, immediate, skybox).
 *   eye      — the eye's layers, plus the layer rig's post run and (when the rig is not rounded this
 *              frame) its display run: all drawn through the photo views.
 *   display  — the display run, when it is rounded: picked through the round views.
 * @returns {{ eye: number[], display: number[] }}
 */
export function cursorPickPlan(eyeLayers, layerRigs, skip = []) {
  const no = new Set(skip);
  const eye = (eyeLayers || []).filter((id) => !no.has(id));
  const moved = layerRigs && layerRigs.active !== false ? layerRigs.moved : null;
  if (!moved || (!moved.display?.length && !moved.post?.length)) return { eye, display: [] };
  const rounded = !!(layerRigs.lastRound && layerRigs.lastRound.length >= 2);
  const add = (list, ids) => {
    for (const id of ids || []) if (!no.has(id) && !list.includes(id)) list.push(id);
  };
  const display = [];
  if (rounded) add(display, moved.display);
  else add(eye, moved.display);
  add(eye, moved.post);
  return { eye, display: display.filter((id) => !eye.includes(id)) };
}

/**
 * The picked point nearest the viewer: the smallest distance along the eye's forward `f` (world),
 * i.e. the most crossed disparity. `pts` are {x, y, z} or [x, y, z] (null = nothing there).
 * @returns {number[]|null} [x, y, z], or null when nothing was hit.
 */
export function nearestPickPoint(pts, f) {
  let best = Infinity;
  let nearest = null;
  for (const p of pts || []) {
    if (!p) continue;
    const x = Array.isArray(p) ? p[0] : p.x, y = Array.isArray(p) ? p[1] : p.y, z = Array.isArray(p) ? p[2] : p.z;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const d = x * f[0] + y * f[1] + z * f[2];
    if (d < best) {
      best = d;
      nearest = [x, y, z];
    }
  }
  return nearest;
}

/**
 * Turn a display-rig pick into the WORLD point the PHOTO views show at the same place.
 *
 * The pick was drawn from round eye 0 (`rounds[i].view` maps rig space to round eye i); a sample at
 * canvas (u, v) with view distance `dist` is the round-space point X. Each round eye i shows X at
 * the pixel where the PHOTO eye i (pose `poses[i]`, rig space) sees P_i · view_round_i · X, so the
 * point the photo views put at both eyes' pixels is where the photo rays of the first and last eye
 * through those points meet. Taken ON eye 0's ray (the pixel that was sampled stays exact) at its
 * closest approach to the last eye's (exact whenever the rays meet: eyes level with each other).
 * Mapped to world by the rig node's transform `R`. With no rounding (round view = photo view) it
 * is X itself.
 * @returns {((u: number, v: number, dist: number) => number[]|null)|null}
 */
export function displayRigPickSolver(proj, rounds, poses, R) {
  const L = rounds.length - 1;
  if (L < 1 || poses.length <= L) return null;
  const T0 = mul4(poses[0], mul4(rounds[0].view, rounds[0].viewInv));
  const TL = mul4(poses[L], mul4(rounds[L].view, rounds[0].viewInv));
  const E0 = [poses[0][12], poses[0][13], poses[0][14]];
  const EL = [poses[L][12], poses[L][13], poses[L][14]];
  return (u, v, dist) => {
    if (!(dist > 0)) return null;
    // Round eye 0's view space: the direction through NDC (x, y) is ((x + c)/a, (y + d)/b, -1).
    const x = 2 * u - 1, y = 1 - 2 * v;
    const Xe = [((x + proj[8]) / proj[0]) * dist, ((y + proj[9]) / proj[5]) * dist, -dist];
    const Q0 = apply(T0, Xe), QL = apply(TL, Xe);
    const P = closestApproach(E0, sub3(Q0, E0), EL, sub3(QL, EL)) || Q0;
    const w = apply(R, P);
    return Number.isFinite(w[0]) && Number.isFinite(w[1]) && Number.isFinite(w[2]) ? w : null;
  };
}

function sub3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/** Column-major 4x4 × point (w = 1, affine). */
function apply(m, p) {
  return [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
}

/** The point of p1 + s·d1 closest to the line p2 + r·d2; null when (near) parallel. */
function closestApproach(p1, d1, p2, d2) {
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const w0 = sub3(p1, p2);
  const aa = dot(d1, d1), bb = dot(d1, d2), cc = dot(d2, d2), dd = dot(d1, w0), ee = dot(d2, w0);
  const den = aa * cc - bb * bb;
  if (!(den > 1e-12 * aa * cc)) return null;
  const s = (bb * ee - cc * dd) / den;
  return [0, 1, 2].map((i) => p1[i] + s * d1[i]);
}

/** Point a pick camera along a view: its projection override, near/far, and rig-space pose. */
function placePickCam(cam, proj, pose, near, far) {
  cam._dxrProj.set(proj);
  if (near > 0 && far > near) {
    cam.camera.nearClip = near;
    cam.camera.farClip = far;
  }
  if (cam.camera.camera) cam.camera.camera._projMatDirty = true;
  const q = quatFromMatrix(pose);
  cam.setLocalPosition(pose[12], pose[13], pose[14]);
  cam.setLocalRotation(q[0], q[1], q[2], q[3]);
}

/** The picker draws only sublayers whose camera list holds the camera: give it these layers (on change only). */
function setCamLayers(cam, ids) {
  const key = ids.join(',');
  if (cam._dxrLayersKey === key) return;
  cam._dxrLayersKey = key;
  cam.camera.layers = ids.slice();
}

/** General column-major 4x4 inverse (cofactors); null when singular. */
function invert4(m) {
  const a = m, o = new Array(16);
  o[0] = a[5]*a[10]*a[15]-a[5]*a[11]*a[14]-a[9]*a[6]*a[15]+a[9]*a[7]*a[14]+a[13]*a[6]*a[11]-a[13]*a[7]*a[10];
  o[4] = -a[4]*a[10]*a[15]+a[4]*a[11]*a[14]+a[8]*a[6]*a[15]-a[8]*a[7]*a[14]-a[12]*a[6]*a[11]+a[12]*a[7]*a[10];
  o[8] = a[4]*a[9]*a[15]-a[4]*a[11]*a[13]-a[8]*a[5]*a[15]+a[8]*a[7]*a[13]+a[12]*a[5]*a[11]-a[12]*a[7]*a[9];
  o[12] = -a[4]*a[9]*a[14]+a[4]*a[10]*a[13]+a[8]*a[5]*a[14]-a[8]*a[6]*a[13]-a[12]*a[5]*a[10]+a[12]*a[6]*a[9];
  o[1] = -a[1]*a[10]*a[15]+a[1]*a[11]*a[14]+a[9]*a[2]*a[15]-a[9]*a[3]*a[14]-a[13]*a[2]*a[11]+a[13]*a[3]*a[10];
  o[5] = a[0]*a[10]*a[15]-a[0]*a[11]*a[14]-a[8]*a[2]*a[15]+a[8]*a[3]*a[14]+a[12]*a[2]*a[11]-a[12]*a[3]*a[10];
  o[9] = -a[0]*a[9]*a[15]+a[0]*a[11]*a[13]+a[8]*a[1]*a[15]-a[8]*a[3]*a[13]-a[12]*a[1]*a[11]+a[12]*a[3]*a[9];
  o[13] = a[0]*a[9]*a[14]-a[0]*a[10]*a[13]-a[8]*a[1]*a[14]+a[8]*a[2]*a[13]+a[12]*a[1]*a[10]-a[12]*a[2]*a[9];
  o[2] = a[1]*a[6]*a[15]-a[1]*a[7]*a[14]-a[5]*a[2]*a[15]+a[5]*a[3]*a[14]+a[13]*a[2]*a[7]-a[13]*a[3]*a[6];
  o[6] = -a[0]*a[6]*a[15]+a[0]*a[7]*a[14]+a[4]*a[2]*a[15]-a[4]*a[3]*a[14]-a[12]*a[2]*a[7]+a[12]*a[3]*a[6];
  o[10] = a[0]*a[5]*a[15]-a[0]*a[7]*a[13]-a[4]*a[1]*a[15]+a[4]*a[3]*a[13]+a[12]*a[1]*a[7]-a[12]*a[3]*a[5];
  o[14] = -a[0]*a[5]*a[14]+a[0]*a[6]*a[13]+a[4]*a[1]*a[14]-a[4]*a[2]*a[13]-a[12]*a[1]*a[6]+a[12]*a[2]*a[5];
  o[3] = -a[1]*a[6]*a[11]+a[1]*a[7]*a[10]+a[5]*a[2]*a[11]-a[5]*a[3]*a[10]-a[9]*a[2]*a[7]+a[9]*a[3]*a[6];
  o[7] = a[0]*a[6]*a[11]-a[0]*a[7]*a[10]-a[4]*a[2]*a[11]+a[4]*a[3]*a[10]+a[8]*a[2]*a[7]-a[8]*a[3]*a[6];
  o[11] = -a[0]*a[5]*a[11]+a[0]*a[7]*a[9]+a[4]*a[1]*a[11]-a[4]*a[3]*a[9]-a[8]*a[1]*a[7]+a[8]*a[3]*a[5];
  o[15] = a[0]*a[5]*a[10]-a[0]*a[6]*a[9]-a[4]*a[1]*a[10]+a[4]*a[2]*a[9]+a[8]*a[1]*a[6]-a[8]*a[2]*a[5];
  const det = a[0]*o[0]+a[1]*o[4]+a[2]*o[8]+a[3]*o[12];
  if (!det || !Number.isFinite(det)) return null;
  for (let i = 0; i < 16; i++) o[i] /= det;
  return o;
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

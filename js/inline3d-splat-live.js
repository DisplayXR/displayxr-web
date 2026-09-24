// inline3d-splat-live.js — setSource's LIVE outgoing asset (engine:'playcanvas'), and the
// background yield prepareSource's own passes run on.
//
// Internal. Used by ./inline3d-splat-playcanvas.js only.
//
// WHY. Since 1.12.1 a crossfade / wavefront blends IMAGES (FRAME_SNAPSHOT): the outgoing photo is
// the last frame it drew, frozen into a texture for the whole transition. On a tracked 3D panel a
// still image under a moving head reads exactly as "tracking hung" — the field report that led
// here. LIVE keeps the outgoing asset resident and renders it every frame of the window, through
// the same eye views as the incoming one, into its own render target; the same two overlay quads
// then lerp (or wipe) the two LIVE images per eye. The blend maths is unchanged — only the texture
// the overlay samples is live instead of frozen.
//
// HOW (the engine's single-camera N-RenderView path):
//   - a second camera ("outgoing eye"), priority −1 so it renders before the eye, into an RGBA8
//     target the size of the canvas buffer: every eye viewport sits in it exactly where it sits in
//     the canvas, so the overlay's gl_FragCoord lookup reads the matching eye (as with the frozen
//     capture). Its OWN RenderViews, set from the same entries as the eye's every frame.
//   - its own layer. The engine's gsplat director keeps ONE manager per (camera, layer) — own
//     work buffer, own sort, own budget — so the outgoing entity moves to this layer and ONLY
//     this camera renders it; the eye camera keeps the World layer with ONLY the incoming asset.
//     Anything else would put both 1.18M assets in both managers.
//   - the window ends by disabling the camera: the director destroys its manager (work buffer,
//     sorter) on the next update, and the outgoing asset is released as before.
//
// THE RIG. The incoming asset's rig (camera rig: its capture pose, lens and convergence; display
// rig: its fit and focus) is adopted at once, as in the frozen path, so the views the runtime
// hands us after that are the INCOMING photo's. The outgoing camera is parented under a node
// chain that maps them back to the OUTGOING photo's framing:
//     N = R_o · K_o · D_o · D_n⁻¹ · K_n⁻¹
// with R the rig node (inverse pivot), K the mono/capture pose in rig space and
// D = diag(c·t, c·t, c) (c = convergence distance, t = tan(vfov/2)). The eye poses (head
// motion) pass through untouched; the outgoing photo keeps its own window and zero-disparity
// plane. Two display-rig assets cancel to N = R_o (the old fit and focus); in controls:'page' the
// page owns the camera and N is the rig node itself.

/** setSource's `outgoing` option. */
export const OUTGOING_MODES = Object.freeze(['live', 'frozen']);

/** Validate `outgoing` (undefined = the default, resolved at swap time). */
export function resolveOutgoingOption(v) {
  if (v === undefined || v === null) return null;
  if (!OUTGOING_MODES.includes(v)) {
    throw new Error(`@displayxr/inline3d/splat: setSource outgoing '${v}' — expected 'live' or 'frozen'.`);
  }
  return v;
}

/** The default: live in a woven (3D) session, frozen in 2D (one draw instead of two). */
export function defaultOutgoing(is3D) {
  return is3D ? 'live' : 'frozen';
}

/**
 * Background yield for prepareSource: an idle period where the browser has one (bounded, so a
 * busy page still makes progress), else a macrotask. The swap path keeps `scheduler.yield()`.
 */
export function yieldIdle(timeout = 200) {
  if (typeof requestIdleCallback === 'function') return new Promise((r) => requestIdleCallback(() => r(), { timeout }));
  return new Promise((r) => setTimeout(r, 0));
}

// ── small matrix helpers (column-major 4×4), kept local: no import cycle with the adapter ──

function mul(a, b, out = new Float64Array(16)) {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

/** Inverse of a similarity (rotation · uniform scale + translation). */
function invertSimilarity(m, out = new Float64Array(16)) {
  const s2 = m[0] * m[0] + m[1] * m[1] + m[2] * m[2] || 1;
  // R⁻¹ = Rᵀ / s²
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) out[c * 4 + r] = m[r * 4 + c] / s2;
  out[3] = out[7] = out[11] = 0;
  for (let r = 0; r < 3; r++) out[12 + r] = -(out[r] * m[12] + out[4 + r] * m[13] + out[8 + r] * m[14]);
  out[15] = 1;
  return out;
}

/** Position, unit quaternion (xyzw) and uniform scale of a similarity. */
export function similarityTRS(m) {
  const s = Math.hypot(m[0], m[1], m[2]) || 1;
  const m11 = m[0] / s, m12 = m[4] / s, m13 = m[8] / s;
  const m21 = m[1] / s, m22 = m[5] / s, m23 = m[9] / s;
  const m31 = m[2] / s, m32 = m[6] / s, m33 = m[10] / s;
  const tr = m11 + m22 + m33;
  let x, y, z, w;
  if (tr > 0) {
    const k = 0.5 / Math.sqrt(tr + 1);
    w = 0.25 / k; x = (m32 - m23) * k; y = (m13 - m31) * k; z = (m21 - m12) * k;
  } else if (m11 > m22 && m11 > m33) {
    const k = 2 * Math.sqrt(1 + m11 - m22 - m33);
    w = (m32 - m23) / k; x = 0.25 * k; y = (m12 + m21) / k; z = (m13 + m31) / k;
  } else if (m22 > m33) {
    const k = 2 * Math.sqrt(1 + m22 - m11 - m33);
    w = (m13 - m31) / k; x = (m12 + m21) / k; y = 0.25 * k; z = (m23 + m32) / k;
  } else {
    const k = 2 * Math.sqrt(1 + m33 - m11 - m22);
    w = (m21 - m12) / k; x = (m13 + m31) / k; y = (m23 + m32) / k; z = 0.25 * k;
  }
  return { position: [m[12], m[13], m[14]], rotation: [x, y, z, w], scale: s };
}

/**
 * The node chain's three pieces from two lens frames (viewer.lensFrame(): { rig, pose, c, t }):
 * N1 = R_o·K_o (similarity), N2 = diag(a, a, b), N3 = K_n⁻¹ (rigid). N1·N2·N3 = N.
 */
export function outgoingChain(oldFrame, newFrame) {
  const n1 = mul(oldFrame.rig, oldFrame.pose);
  const a = (oldFrame.c * oldFrame.t) / (newFrame.c * newFrame.t);
  const b = oldFrame.c / newFrame.c;
  const n3 = invertSimilarity(newFrame.pose);
  return {
    n1: similarityTRS(n1),
    scale: [Number.isFinite(a) && a > 0 ? a : 1, Number.isFinite(a) && a > 0 ? a : 1, Number.isFinite(b) && b > 0 ? b : 1],
    n3: similarityTRS(n3),
  };
}

function setTRS(node, trs) {
  node.setLocalPosition(trs.position[0], trs.position[1], trs.position[2]);
  node.setLocalRotation(trs.rotation[0], trs.rotation[1], trs.rotation[2], trs.rotation[3]);
  node.setLocalScale(trs.scale, trs.scale, trs.scale);
}

/**
 * The live outgoing renderer for one viewer. Engine objects are made on first use and kept (the
 * layer, the camera entity, the node chain); the render target lives for one window only.
 */
export class LiveOutgoing {
  constructor(viewer) {
    this.viewer = viewer;
    this.active = false;
    this.entity = null;
    this.layer = null;
    this.cam = null;
    this.nodes = null;
    this.rt = null;
    this.tex = null;
    this.w = 0;
    this.h = 0;
    this.oldFrame = null;
    this.frames = 0;
    this.views = [];
    this._frustumKey = '';
  }

  /** Engine support for this path: RenderViews on one camera, render targets, layers. */
  static supported(viewer) {
    const pc = viewer.pc;
    return !!(viewer.app && pc && viewer._viewPath === 'renderview' && pc.RenderTarget && pc.Texture && pc.Layer && viewer.eye);
  }

  _ensureEngineObjects() {
    const v = this.viewer;
    const pc = v.pc;
    const app = v.app;
    if (!this.layer) {
      this.layer = new pc.Layer({ name: 'inline3d-outgoing' });
      app.scene.layers.push(this.layer);
    }
    if (!this.cam) {
      const n1 = new pc.Entity('inline3d-outgoing-rig', app);
      const n2 = new pc.Entity('inline3d-outgoing-lens', app);
      const n3 = new pc.Entity('inline3d-outgoing-pose', app);
      app.root.addChild(n1);
      n1.addChild(n2);
      n2.addChild(n3);
      this.nodes = { n1, n2, n3 };
      const cam = v._makeCamera('inline3d-outgoing-eye', null); // same clear, tone mapping, near/far
      v.rigNode.removeChild?.(cam);
      n3.addChild(cam);
      cam.camera.layers = [this.layer.id];
      cam.camera.priority = -1; // before the eye: the eye's overlay samples its target
      cam.enabled = false;
      this.cam = cam;
    }
  }

  _ensureTarget(w, h) {
    if (this.rt && this.w === w && this.h === h) return;
    this._destroyTarget();
    const pc = this.viewer.pc;
    const device = this.viewer.app.graphicsDevice;
    this.tex = new pc.Texture(device, {
      name: 'inline3d-outgoing',
      width: w,
      height: h,
      format: pc.PIXELFORMAT_RGBA8,
      mipmaps: false,
      minFilter: pc.FILTER_NEAREST,
      magFilter: pc.FILTER_NEAREST,
      addressU: pc.ADDRESS_CLAMP_TO_EDGE,
      addressV: pc.ADDRESS_CLAMP_TO_EDGE,
    });
    this.rt = new pc.RenderTarget({ colorBuffer: this.tex, depth: false });
    this.w = w;
    this.h = h;
    if (this.cam) this.cam.camera.renderTarget = this.rt;
  }

  _destroyTarget() {
    if (this.cam) this.cam.camera.renderTarget = null;
    this.rt?.destroy?.();
    this.tex?.destroy?.();
    this.rt = this.tex = null;
    this.w = this.h = 0;
  }

  /**
   * Take `entity` (the outgoing splat, still enabled) onto the live layer. `oldFrame` is
   * viewer.lensFrame() read BEFORE the incoming asset's rig was adopted. Returns false if this
   * engine build cannot (the caller keeps the frozen frame).
   */
  start(entity, oldFrame) {
    const v = this.viewer;
    if (!LiveOutgoing.supported(v) || !entity?.gsplat) return false;
    try {
      this._ensureEngineObjects();
      this._ensureTarget(v.canvas.width, v.canvas.height);
      entity.gsplat.layers = [this.layer.id];
      this.entity = entity;
      this.oldFrame = oldFrame;
      this.frames = 0;
      this.cam.enabled = true;
      this.active = true;
      return true;
    } catch (err) {
      console.warn('[inline3d/splat] live outgoing unavailable; the transition keeps the frozen frame', err);
      this.stop();
      return false;
    }
  }

  /** The target the overlay samples. */
  get texture() {
    return this.tex;
  }

  /** Fits the canvas buffer (a resize or a 2D/3D switch mid-window ends the transition). */
  get fits() {
    return this.w === this.viewer.canvas.width && this.h === this.viewer.canvas.height;
  }

  /**
   * The outgoing camera has drawn a sorted frame: its manager exists and its world state has been
   * sorted at least once. Until then the overlay keeps the frozen bridge (the first frames of a
   * fresh manager draw nothing while its work buffer and first sort are built). An engine build
   * whose internals differ: ready after 3 drawn frames.
   */
  get ready() {
    if (!this.active) return false;
    const mgr = this.manager;
    if (mgr === undefined) return this.frames >= 3;
    const w = mgr?.world;
    const st = w?.getState?.(w.lastWorldStateVersion);
    return !!st?.sortedBefore && this.frames >= 1;
  }

  /** The director's manager for (this camera, this layer): null = none yet, undefined = unknown engine. */
  get manager() {
    const dir = this.viewer.app?.renderer?.gsplatDirector;
    if (!dir?.camerasMap || !this.cam) return undefined;
    const cd = dir.camerasMap.get(this.cam.camera.camera);
    return cd?.layersMap?.get(this.layer)?.gsplatManager ?? null;
  }

  /**
   * Per frame, before the engine tick: the eye's views on the outgoing camera (same proj, pose,
   * viewport), the eye's node pose, and the rig chain.
   */
  sync(entries, rect, frustum) {
    if (!this.active) return;
    const v = this.viewer;
    const pc = v.pc;
    const rvs = this.views;
    if (rvs.length !== entries.length) {
      rvs.length = 0;
      for (let i = 0; i < entries.length; i++) rvs.push(new pc.RenderView());
      this.cam.camera.camera.xrViews = rvs.slice();
    }
    for (let i = 0; i < entries.length; i++) {
      rvs[i].setView(entries[i].proj, entries[i].pose);
      const [x, y, w, h] = rect(entries[i]);
      rvs[i].setViewport(x, y, w, h);
    }
    if (frustum) {
      const key = `${frustum.fov.toFixed(4)}|${frustum.aspectRatio.toFixed(4)}|${frustum.nearClip}|${frustum.farClip}`;
      if (key !== this._frustumKey) {
        this._frustumKey = key;
        this.cam.camera.camera.setXrProperties({ ...frustum, horizontalFov: false });
      }
    }
    // The node chain (see the header). controls:'page': the page's camera, for both assets.
    const { n1, n2, n3 } = this.nodes;
    if (v.pageCamera || !this.oldFrame) {
      const r = similarityTRS(v.rigMatrix());
      setTRS(n1, r);
      n2.setLocalScale(1, 1, 1);
      setTRS(n3, { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: 1 });
    } else {
      const ch = outgoingChain(this.oldFrame, v.lensFrame());
      setTRS(n1, ch.n1);
      n2.setLocalScale(ch.scale[0], ch.scale[1], ch.scale[2]);
      setTRS(n3, ch.n3);
    }
    // The camera NODE (sort direction, LOD distance) parks on the first eye, as the eye's does.
    const e = v.eye;
    const p = e.getLocalPosition();
    const q = e.getLocalRotation();
    this.cam.setLocalPosition(p.x, p.y, p.z);
    this.cam.setLocalRotation(q.x, q.y, q.z, q.w);
    this.frames++;
  }

  /** End the window: camera off (the director drops its manager), target freed. */
  stop() {
    // The outgoing entity is NOT put back on its old layer: the caller releases it right after,
    // and a round trip through World would dirty the eye's manager (a work-buffer rebuild).
    this.entity = null;
    this.oldFrame = null;
    this.active = false;
    if (this.cam) this.cam.enabled = false;
    this._destroyTarget();
  }

  destroy() {
    this.stop();
    try {
      if (this.layer) this.viewer.app?.scene?.layers?.remove?.(this.layer);
    } catch {
      /* app already gone */
    }
    this.layer = null;
    this.cam = null;
    this.nodes = null;
  }
}

// inline3d-splat-video.js — handle.setVideo(): a stereo video ON the persistent PlayCanvas splat
// handle (docs/playcanvas-adapter.md §setVideo). Internal to ./inline3d-splat-playcanvas.js.
//
// WHY ON THE HANDLE. A page that renders everything through ONE persistent woven canvas (rule 3 of
// docs/woven-canvas-rules.md) cannot put a movie in a second canvas without re-creating the very
// window the persistent stage exists to remove (a fresh canvas is fresh to the compositor: the raw
// side-by-side flash). So the video is drawn by the tile's own engine, in the tile's own frame.
//
// HOW IT IS DRAWN. One quad, parented under the RIG NODE (the eye camera's parent), at display
// space z = 0: RenderView composes the rig node into every view, so a child of it is fixed relative
// to the eyes whatever the pose (orbit, zoom, focus) — the plane is screen-locked by construction,
// and exit restores the pose untouched. On the display rig the z = 0 plane spans the element
// (docs/authoring-inline-3d.md §display rig), so the quad is the element box contained / covered by
// the video's per-eye aspect. Zero disparity for the quad itself: the depth is the video's own.
//
// EACH EYE SEES ONLY ITS HALF. One camera draws every view (the RenderView path), so the shader
// cannot be told "this is the right eye" by a uniform per view. It does not need to be: the eye
// viewports sit side by side in the buffer, so gl_FragCoord.x against the first right-eye
// viewport's x says which eye this fragment belongs to. Mono (not woven): the split is +∞, every
// fragment samples the LEFT half, at the full buffer resolution. The sample is clamped half a texel
// inside its half, so linear filtering never bleeds the other eye across the seam.
//
// UPLOAD. Gated on requestVideoFrameCallback (a new frame was presented), with `seeked` and a
// currentTime change as fallbacks (no rVFC; a paused seek on a build that does not fire it). One
// texture, re-specified from the <video> by the engine (texImage2D; GPU-to-GPU in Chromium): no
// per-frame allocation on our side. RGBA8, sampled and written UNCHANGED — the same encoded sRGB
// values a 2D canvas drawImage() of the frame puts in the buffer (addVideo's paint), so the woven
// video and the flat one are the same pixels.

/** handle.setVideo's formats, fits and rigs. */
export const VIDEO_FORMATS = Object.freeze(['sbs', 'tb', 'mono']);
export const VIDEO_FITS = Object.freeze(['contain', 'cover']);
const VIDEO_OPTION_KEYS = new Set(['format', 'fit', 'rig', 'virtualDisplayHeight', 'loop', 'muted', 'autoplay']);
let warnedVideoKeys = false;

export const PAGE_VIDEO_ERROR =
  "@displayxr/inline3d/splat: setVideo() is not available with controls:'page' — the page owns the " +
  'camera, and a video plane needs the display rig. Draw the video into your own scene instead.';

/**
 * setVideo's arguments, validated and resolved (throws at the call, before anything runs).
 * `src` null/undefined is the exit call and is not validated here.
 * @returns {{ src: string|HTMLVideoElement, format: 'sbs'|'tb'|'mono', fit: 'contain'|'cover',
 *            vH: number|undefined, loop?: boolean, muted?: boolean, autoplay?: boolean }}
 */
export function validateSetVideo(src, o = {}, pageMode = false) {
  if (pageMode) throw new Error(PAGE_VIDEO_ERROR);
  const isVideo = typeof HTMLVideoElement !== 'undefined' ? src instanceof HTMLVideoElement : !!src && typeof src === 'object' && 'videoWidth' in src;
  if (!(typeof src === 'string' && src.length > 0) && !isVideo) {
    throw new TypeError('@displayxr/inline3d/splat: setVideo(src) — expected a URL string, an HTMLVideoElement, or null to exit.');
  }
  if (o === null || typeof o !== 'object') throw new TypeError('@displayxr/inline3d/splat: setVideo options must be an object.');
  const unknown = Object.keys(o).filter((k) => !VIDEO_OPTION_KEYS.has(k));
  if (unknown.length && !warnedVideoKeys) {
    warnedVideoKeys = true;
    console.warn(`[inline3d/splat] setVideo ignores ${unknown.join(', ')}.`);
  }
  const format = o.format === undefined ? 'sbs' : o.format;
  if (!VIDEO_FORMATS.includes(format)) {
    throw new Error(`@displayxr/inline3d/splat: setVideo — format "${format}", expected ${VIDEO_FORMATS.join(' | ')}.`);
  }
  const fit = o.fit === undefined ? 'contain' : o.fit;
  if (!VIDEO_FITS.includes(fit)) throw new Error(`@displayxr/inline3d/splat: setVideo — fit "${fit}", expected ${VIDEO_FITS.join(' | ')}.`);
  if (o.rig !== undefined && o.rig !== 'display') {
    throw new Error(`@displayxr/inline3d/splat: setVideo — rig "${o.rig}"; a video plays on the display rig only ('display').`);
  }
  let vH;
  if (o.virtualDisplayHeight !== undefined) {
    vH = o.virtualDisplayHeight;
    if (!Number.isFinite(vH) || !(vH > 0)) throw new Error(`@displayxr/inline3d/splat: setVideo — bad virtualDisplayHeight: ${o.virtualDisplayHeight}.`);
  }
  const bool = (k) => (o[k] === undefined ? undefined : !!o[k]);
  return { src, format, fit, vH, loop: bool('loop'), muted: bool('muted'), autoplay: bool('autoplay') };
}

/**
 * The per-eye source regions in texture space (st: s → right, t → DOWN, i.e. image rows), as
 * [s0, t0, ds, dt] for the left and the right eye.
 */
export function eyeRegions(format) {
  if (format === 'tb') return { L: [0, 0, 1, 0.5], R: [0, 0.5, 1, 0.5] };
  if (format === 'mono') return { L: [0, 0, 1, 1], R: [0, 0, 1, 1] };
  return { L: [0, 0, 0.5, 1], R: [0.5, 0, 0.5, 1] };
}

/** One eye's aspect (width / height) of a `videoWidth × videoHeight` frame in `format`. */
export function eyeAspect(format, w, h) {
  if (!(w > 0) || !(h > 0)) return 0;
  if (format === 'sbs') return w / 2 / h;
  if (format === 'tb') return w / (h / 2);
  return w / h;
}

/**
 * The quad's size at display-space z = 0, where the window is `vH · boxAspect` wide and `vH` tall:
 * the window contained ('contain': all of the frame, bars where the aspects differ) or covered
 * ('cover': the window full, the overflow cut by the window's own frustum edges).
 */
export function videoPlaneSize({ boxAspect, eyeAspect: a, vH, fit = 'contain' }) {
  const W = vH * boxAspect;
  const H = vH;
  if (!(a > 0) || !(boxAspect > 0)) return { w: W, h: H };
  const wider = a >= boxAspect;
  if ((fit === 'contain') === wider) return { w: W, h: W / a };
  return { w: H * a, h: H };
}

/**
 * The first right-eye pixel column in the buffer for this frame's views (entries in BUFFER px,
 * through `rect`), or +∞ for one view (mono: every fragment is the left eye). With N > 2 views the
 * first half of them are left eyes.
 */
export function eyeSplit(entries, rect) {
  if (!entries || entries.length < 2) return 1e9;
  return rect(entries[entries.length >> 1])[0];
}

const VERT = `
attribute vec3 vertex_position;
attribute vec2 vertex_texCoord0;
uniform mat4 matrix_model;
uniform mat4 matrix_viewProjection;
varying vec2 vUv;
void main() {
  vUv = vertex_texCoord0;
  gl_Position = matrix_viewProjection * matrix_model * vec4(vertex_position, 1.0);
}`;
const FRAG = `
varying vec2 vUv;
uniform sampler2D dxrVid;
uniform vec4 dxrVidL;      // left eye's region: s0, t0, ds, dt (t = image rows, top = 0)
uniform vec4 dxrVidR;      // right eye's
uniform vec2 dxrVidTexel;  // half a texel, per axis
uniform float dxrVidSplit; // first right-eye pixel column in the buffer (1e9 = mono)
void main() {
  vec4 r = gl_FragCoord.x >= dxrVidSplit ? dxrVidR : dxrVidL;
  vec2 st = r.xy + vec2(vUv.x, 1.0 - vUv.y) * r.zw;
  st = clamp(st, r.xy + dxrVidTexel, r.xy + r.zw - dxrVidTexel);
  gl_FragColor = vec4(texture2D(dxrVid, st).rgb, 1.0);
}`;

/**
 * The quad, its material and its texture, owned by the viewer (`viewer._videoPlane`) while a video
 * is on. `beforeDraw` is called by the viewer's draw, once per engine tick, before the tick.
 */
export class VideoPlane {
  constructor(viewer) {
    this.viewer = viewer;
    const pc = (this.pc = viewer.pc);
    const device = viewer.app.graphicsDevice;
    const mesh = new pc.Mesh(device);
    mesh.setPositions(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]));
    mesh.setUvs(0, new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]));
    mesh.setIndices([0, 1, 2, 0, 2, 3]);
    mesh.update();
    this.mesh = mesh;
    const mat = new pc.ShaderMaterial({
      uniqueName: 'inline3dVideoPlane',
      attributes: { vertex_position: pc.SEMANTIC_POSITION, vertex_texCoord0: pc.SEMANTIC_TEXCOORD0 },
      vertexGLSL: VERT,
      fragmentGLSL: FRAG,
    });
    mat.cull = pc.CULLFACE_NONE;
    mat.setParameter('dxrVidSplit', 1e9);
    mat.update();
    this.mat = mat;
    // Under the rig node: fixed relative to the eyes (see the header).
    this.node = new pc.GraphNode('inline3d-video');
    viewer.rigNode.addChild(this.node);
    const mi = new pc.MeshInstance(mesh, mat, this.node);
    mi.cull = false;
    mi.visible = false;
    this.mi = mi;
    this.layer = viewer.app.scene.layers.getLayerById(pc.LAYERID_WORLD ?? 0);
    this.layer.addMeshInstances([mi]);

    this.video = null;
    this.tex = null;
    this.format = 'sbs';
    this.fit = 'contain';
    this.vH = viewer.vH;
    this._dirty = false;
    this._lastT = -1;
    this._rvfc = 0;
    this._sizeKey = '';
    this._split = NaN;
    this._onSeeked = () => (this._dirty = true);
    /** Upload accounting (handle.setVideo(...).stats()). */
    this.uploads = 0;
    this.frames = 0;
  }

  /** Play `video` on the quad (a new element, format or fit). The element must have a frame. */
  setSource(video, { format, fit, vH }) {
    this.format = format;
    this.fit = fit;
    this.vH = vH;
    const r = eyeRegions(format);
    this.mat.setParameter('dxrVidL', r.L);
    this.mat.setParameter('dxrVidR', r.R);
    if (video !== this.video) {
      this._unwatch();
      this.video = video;
      this._watch();
    }
    this._ensureTexture();
    this._sizeKey = '';
    this._dirty = true;
    this.mat.update();
    this.mi.visible = true;
  }

  _watch() {
    const v = this.video;
    v.addEventListener?.('seeked', this._onSeeked);
    if (typeof v.requestVideoFrameCallback === 'function') {
      const cb = () => {
        this._dirty = true;
        if (this.video === v) this._rvfc = v.requestVideoFrameCallback(cb);
      };
      this._rvfc = v.requestVideoFrameCallback(cb);
    }
  }

  _unwatch() {
    const v = this.video;
    if (!v) return;
    v.removeEventListener?.('seeked', this._onSeeked);
    if (this._rvfc && typeof v.cancelVideoFrameCallback === 'function') v.cancelVideoFrameCallback(this._rvfc);
    this._rvfc = 0;
  }

  /** One texture per video size; re-made only when the frame size changes. */
  _ensureTexture() {
    const pc = this.pc;
    const v = this.video;
    const w = v.videoWidth || 0;
    const h = v.videoHeight || 0;
    if (this.tex && this.tex.width === w && this.tex.height === h) return;
    this.tex?.destroy?.();
    this.tex = new pc.Texture(this.viewer.app.graphicsDevice, {
      name: 'inline3d-video',
      width: Math.max(1, w),
      height: Math.max(1, h),
      format: pc.PIXELFORMAT_RGBA8,
      mipmaps: false,
      flipY: false,
      minFilter: pc.FILTER_LINEAR,
      magFilter: pc.FILTER_LINEAR,
      addressU: pc.ADDRESS_CLAMP_TO_EDGE,
      addressV: pc.ADDRESS_CLAMP_TO_EDGE,
    });
    this.tex.setSource?.(v);
    this.mat.setParameter('dxrVid', this.tex);
    this.mat.setParameter('dxrVidTexel', [0.5 / Math.max(1, w), 0.5 / Math.max(1, h)]);
    this._lastT = v.currentTime;
    this._dirty = false;
    this.uploads++; // setSource uploads
  }

  /** Per engine tick, before it: size the quad, place the eye split, upload a new frame. */
  beforeDraw(entries, rect) {
    const v = this.video;
    if (!v || !this.mi.visible) return;
    this.frames++;
    const split = eyeSplit(entries, rect);
    if (split !== this._split) {
      this._split = split;
      this.mat.setParameter('dxrVidSplit', split);
    }
    const boxAspect = this.viewer.boxAspect;
    const key = `${boxAspect}|${v.videoWidth}x${v.videoHeight}|${this.format}|${this.fit}|${this.vH}`;
    if (key !== this._sizeKey) {
      this._sizeKey = key;
      this._ensureTexture();
      const s = videoPlaneSize({ boxAspect, eyeAspect: eyeAspect(this.format, v.videoWidth, v.videoHeight), vH: this.vH, fit: this.fit });
      this.node.setLocalScale(s.w, s.h, 1);
    }
    // A new frame: rVFC said so, a seek landed, or (no rVFC) the clock moved.
    const t = v.currentTime;
    if (this._dirty || (!this._rvfc && t !== this._lastT)) {
      if ((v.readyState || 0) >= 2) {
        this.tex.upload();
        this.uploads++;
      }
      this._dirty = false;
      this._lastT = t;
    }
  }

  hide() {
    this.mi.visible = false;
  }

  destroy() {
    this._unwatch();
    this.video = null;
    this.layer?.removeMeshInstances?.([this.mi]);
    this.node.parent?.removeChild?.(this.node);
    this.tex?.destroy?.();
    this.tex = null;
    this.mat.destroy?.();
    this.mesh.destroy?.();
  }
}

// ── handle.makeSbsMaterial(): per-eye stereo on ANY quad (docs/proposals/layer-display-rig.md) ──
//
// setVideo's eye pick, lifted out of the full-screen plane: the eye viewports sit side by side in
// the buffer, so `gl_FragCoord.x >= split` is the right eye. The viewer publishes that split every
// draw as a SCENE-WIDE uniform (EYE_SPLIT_UNIFORM, 1e9 in mono / the 2D tier / a 1-view mode), so a
// material only has to declare it — the SDK never has to know which materials are stereo.
// PlayCanvas's own `view_index` is set per RenderView on the single-camera path too, but it is 0
// for every camera on the N-camera fallback path; the split is right on both.

/** The scene-wide uniform the viewer sets every draw: first right-eye pixel column (1e9 = mono). */
export const EYE_SPLIT_UNIFORM = 'dxr_eye_split';

/**
 * GLSL for a custom shader that wants the same pick: declare the uniform, call dxrEyeRegion() with
 * the left and right regions ([s0, t0, ds, dt], t = image rows from the top).
 */
export const SBS_EYE_GLSL = `
uniform float ${EYE_SPLIT_UNIFORM};
vec4 dxrEyeRegion(vec4 left, vec4 right) { return gl_FragCoord.x >= ${EYE_SPLIT_UNIFORM} ? right : left; }`;

const SBS_OPTION_KEYS = new Set(['format', 'opacity', 'flipY', 'depthTest', 'depthWrite', 'cull', 'name']);

/** makeSbsMaterial's options, validated. */
export function validateSbsOptions(texture, o = {}) {
  if (!texture || typeof texture !== 'object') throw new TypeError('@displayxr/inline3d/splat: makeSbsMaterial(texture) — expected a pc.Texture.');
  if (o === null || typeof o !== 'object') throw new TypeError('@displayxr/inline3d/splat: makeSbsMaterial options must be an object.');
  const unknown = Object.keys(o).filter((k) => !SBS_OPTION_KEYS.has(k));
  if (unknown.length) throw new Error(`@displayxr/inline3d/splat: makeSbsMaterial — unknown option(s) ${unknown.join(', ')}.`);
  const format = o.format === undefined ? 'sbs' : o.format;
  if (!VIDEO_FORMATS.includes(format)) throw new Error(`@displayxr/inline3d/splat: makeSbsMaterial — format "${format}", expected ${VIDEO_FORMATS.join(' | ')}.`);
  const opacity = o.opacity === undefined ? 1 : o.opacity;
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error(`@displayxr/inline3d/splat: makeSbsMaterial — bad opacity: ${o.opacity}.`);
  return { format, opacity, flipY: o.flipY === true, depthTest: o.depthTest !== false, depthWrite: o.depthWrite !== false, cull: o.cull === true, name: o.name };
}

const SBS_VERT = `
attribute vec3 vertex_position;
attribute vec2 vertex_texCoord0;
uniform mat4 matrix_model;
uniform mat4 matrix_viewProjection;
varying vec2 vUv;
void main() {
  vUv = vertex_texCoord0;
  gl_Position = matrix_viewProjection * matrix_model * vec4(vertex_position, 1.0);
}`;
const SBS_FRAG = `
varying vec2 vUv;
uniform sampler2D dxrSbsTex;
uniform vec4 dxrSbsL;       // left eye's region: s0, t0, ds, dt (t = image rows, top = 0)
uniform vec4 dxrSbsR;       // right eye's
uniform vec2 dxrSbsTexel;   // half a texel, per axis
uniform float dxrSbsOpacity;
uniform float dxrSbsFlipY;  // 1: the texture's row 0 is the image's BOTTOM
${SBS_EYE_GLSL}
void main() {
  vec4 r = dxrEyeRegion(dxrSbsL, dxrSbsR);
  vec2 st = r.xy + vec2(vUv.x, 1.0 - vUv.y) * r.zw;
  st = clamp(st, r.xy + dxrSbsTexel, r.xy + r.zw - dxrSbsTexel);
  if (dxrSbsFlipY > 0.5) st.y = 1.0 - st.y;
  gl_FragColor = vec4(texture2D(dxrSbsTex, st).rgb, dxrSbsOpacity);
}`;

/**
 * An unlit material that shows the LEFT half of `texture` to left-eye views and the RIGHT half to
 * right-eye views (or top/bottom, or the same picture: `format`), on whatever mesh it is put on.
 * The mesh's geometry is untouched — put the quad at the screen plane and the clip's own disparity
 * is the only depth. Mono: every fragment samples the left region at full resolution. The texture
 * is the page's (a `<video>`'s frames uploaded by the page, an image); nothing is decoded here.
 */
export function makeSbsMaterial(pc, texture, o = {}) {
  const opt = validateSbsOptions(texture, o);
  const mat = new pc.ShaderMaterial({
    uniqueName: 'inline3dSbsQuad',
    attributes: { vertex_position: pc.SEMANTIC_POSITION, vertex_texCoord0: pc.SEMANTIC_TEXCOORD0 },
    vertexGLSL: SBS_VERT,
    fragmentGLSL: SBS_FRAG,
  });
  if (opt.name) mat.name = opt.name;
  mat.cull = opt.cull ? pc.CULLFACE_BACK : pc.CULLFACE_NONE;
  mat.depthTest = opt.depthTest;
  mat.depthWrite = opt.depthWrite;
  if (opt.opacity < 1 && pc.BlendState && pc.BLENDMODE_SRC_ALPHA !== undefined) {
    mat.blendState = new pc.BlendState(true, pc.BLENDEQUATION_ADD, pc.BLENDMODE_SRC_ALPHA, pc.BLENDMODE_ONE_MINUS_SRC_ALPHA);
  }
  const r = eyeRegions(opt.format);
  mat.setParameter('dxrSbsL', r.L);
  mat.setParameter('dxrSbsR', r.R);
  mat.setParameter('dxrSbsOpacity', opt.opacity);
  mat.setParameter('dxrSbsFlipY', opt.flipY ? 1 : 0);
  mat.setParameter('dxrSbsTex', texture);
  const w = Math.max(1, texture.width || 1);
  const h = Math.max(1, texture.height || 1);
  mat.setParameter('dxrSbsTexel', [0.5 / w, 0.5 / h]);
  mat.update();
  return mat;
}

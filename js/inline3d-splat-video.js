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
//
// CROSSFADE (transition: 'crossfade', A5.1 of RFC 0001). A video -> video swap can dissolve on the
// GPU instead of cutting. At the swap the plane's current quad is handed off, as it is, to a GHOST:
// its texture is frozen (no more uploads, so the outgoing <video> can be released at once), and its
// material turns blended, drawn after the incoming quad, fading 1 -> 0 over `durationMs`. The
// incoming video goes onto a fresh quad underneath, opaque from its first frame. So each quad keeps
// its own size, format and fit, and a swap between two aspects fades bar-for-bar. Only between two
// videos: entering from the splat and setVideo(null) stay cuts. A swap while a fade is still
// running drops the old ghost (a small pop) and fades from the video then on screen.
//
// BAND (A5.2). `band: 2.39` (or '2.39:1') narrows the window to a centred letterbox slot of that
// aspect before fitting, exactly as ./player's `band` narrows its tile: the rest of the element
// stays clear. 'contain' in the band is a smaller quad. 'cover' in the band cannot lean on the
// window's frustum edges to cut the overflow (the band is inside the window), so the quad is the
// band exactly and the overflow is cropped in TEXTURE space instead: each eye's region is narrowed
// about its centre. Without a band nothing changes.
import { EASINGS } from './inline3d-splat-effects.js';

/** handle.setVideo's formats, fits and rigs. */
export const VIDEO_FORMATS = Object.freeze(['sbs', 'tb', 'mono']);
export const VIDEO_FITS = Object.freeze(['contain', 'cover']);
const VIDEO_OPTION_KEYS = new Set(['format', 'fit', 'rig', 'virtualDisplayHeight', 'loop', 'muted', 'autoplay', 'transition', 'durationMs', 'easing', 'outgoing', 'band']);
/** setVideo's transitions: the player's vocabulary (./player), not setSource's gaussian ones. */
export const VIDEO_TRANSITIONS = Object.freeze(['cut', 'crossfade']);
/** The player's defaults (DEFAULT_CROSSFADE_MS / easeInOutSine), so both surfaces fade alike. */
export const VIDEO_CROSSFADE_MS = 600;
const VIDEO_CROSSFADE_EASING = 'easeInOutSine';
let warnedVideoKeys = false;

export const PAGE_VIDEO_ERROR =
  "@displayxr/inline3d/splat: setVideo() is not available with controls:'page' — the page owns the " +
  'camera, and a video plane needs the display rig. Draw the video into your own scene instead.';

/**
 * setVideo's arguments, validated and resolved (throws at the call, before anything runs).
 * `src` null/undefined is the exit call and is not validated here.
 * @returns {{ src: string|HTMLVideoElement, format: 'sbs'|'tb'|'mono', fit: 'contain'|'cover',
 *            vH: number|undefined, loop?: boolean, muted?: boolean, autoplay?: boolean,
 *            transition: { type: 'cut'|'crossfade', durationMs: number, easing: string|Function },
 *            band: number|null }}
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
  let band = null;
  if (o.band !== undefined && o.band !== null) {
    band = parseBandAspect(o.band);
    if (band === null) throw new Error(`@displayxr/inline3d/splat: setVideo — bad band: ${JSON.stringify(o.band)} (a number > 0, or 'W:H').`);
  }
  return { src, format, fit, vH, loop: bool('loop'), muted: bool('muted'), autoplay: bool('autoplay'), transition: resolveVideoTransition(o), band };
}

/** A band aspect: a number > 0, or 'W:H' / 'W/H' / 'WxH' / a numeric string. Null if unusable. */
export function parseBandAspect(a) {
  if (typeof a === 'number') return Number.isFinite(a) && a > 0 ? a : null;
  if (typeof a !== 'string') return null;
  const m = a.trim().match(/^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)$/i);
  const v = m ? Number(m[1]) / Number(m[2]) : Number(a);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** setVideo's transition options: `{ type, durationMs, easing }`. Throws on a page bug. */
export function resolveVideoTransition(o = {}) {
  const type = o.transition === undefined ? 'cut' : o.transition;
  if (!VIDEO_TRANSITIONS.includes(type)) {
    const name = typeof type === 'string' ? type : type && typeof type === 'object' ? type.type || 'object' : String(type);
    throw new Error(
      `@displayxr/inline3d/splat: setVideo transition '${name}' — expected ${VIDEO_TRANSITIONS.join(' | ')}. ` +
        "setSource's other transitions move a 3D photo's gaussians; a video frame has none.",
    );
  }
  if (o.outgoing !== undefined && o.outgoing !== 'frozen') {
    throw new Error(`@displayxr/inline3d/splat: setVideo outgoing '${o.outgoing}' — a video crossfade dissolves from the outgoing video's last frame ('frozen').`);
  }
  const durationMs = o.durationMs === undefined ? VIDEO_CROSSFADE_MS : o.durationMs;
  if (!Number.isFinite(durationMs) || durationMs < 0) throw new RangeError(`@displayxr/inline3d/splat: setVideo durationMs must be ≥ 0, got ${o.durationMs}.`);
  const easing = o.easing === undefined ? VIDEO_CROSSFADE_EASING : o.easing;
  if (typeof easing !== 'function' && !(typeof easing === 'string' && Object.prototype.hasOwnProperty.call(EASINGS, easing))) {
    throw new Error(`@displayxr/inline3d/splat: unknown easing '${easing}'.`);
  }
  return { type, durationMs, easing };
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
export function videoPlaneSize({ boxAspect, eyeAspect: a, vH, fit = 'contain', band = null }) {
  const W = vH * boxAspect;
  const H = vH;
  if (!(a > 0) || !(boxAspect > 0)) return { w: W, h: H };
  if (band > 0) {
    const b = videoBandSlot(W, H, band);
    // 'cover': the quad IS the band, and the overflow is cut in texture space (videoCrop).
    if (fit === 'cover') return { w: b.w, h: b.h };
    return a >= band ? { w: b.w, h: b.w / a } : { w: b.h * a, h: b.h }; // the slot's aspect is `band`
  }
  const wider = a >= boxAspect;
  if ((fit === 'contain') === wider) return { w: W, h: W / a };
  return { w: H * a, h: H };
}

/** The centred band slot of aspect `band` inside a W × H window (./player's bandBox, sizes only). */
export function videoBandSlot(W, H, band) {
  if (!(band > 0) || !(W > 0 && H > 0)) return { w: W, h: H };
  return band >= W / H ? { w: W, h: W / band } : { w: H * band, h: H };
}

/**
 * The fraction of each eye's region the quad shows, [fx, fy], centred: [1, 1] except 'cover' in a
 * band, where the quad is the band and the overflow is cropped in texture space.
 */
export function videoCrop({ boxAspect, eyeAspect: a, fit, band }) {
  if (fit !== 'cover' || !(band > 0) || !(a > 0) || !(boxAspect > 0)) return [1, 1];
  // The slot keeps the band's aspect whatever the window, so crop the eye to `band` directly.
  return a >= band ? [band / a, 1] : [1, a / band];
}

/**
 * The quad's on-screen rect in CSS px of a `boxW × boxH` canvas: the display rig's z = 0 plane spans
 * the element, so window units map linearly onto it, centred. Clipped to the canvas (a 'cover' quad
 * outside a band overflows it), rounded to 1/100 px.
 */
export function videoScreenRect({ w, h, W, H }, boxW, boxH) {
  const pw = (w / W) * boxW;
  const ph = (h / H) * boxH;
  const x0 = Math.max(0, (boxW - pw) / 2);
  const y0 = Math.max(0, (boxH - ph) / 2);
  const x1 = Math.min(boxW, (boxW + pw) / 2);
  const y1 = Math.min(boxH, (boxH + ph) / 2);
  const q = (v) => Math.round(v * 100) / 100;
  return Object.freeze({ x: q(x0), y: q(y0), width: q(x1 - x0), height: q(y1 - y0) });
}

/** An eye region [s0, t0, ds, dt] narrowed about its centre to [fx, fy] of itself. */
export function cropRegion(r, [fx, fy]) {
  return [r[0] + (r[2] * (1 - fx)) / 2, r[1] + (r[3] * (1 - fy)) / 2, r[2] * fx, r[3] * fy];
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
uniform float dxrVidAlpha; // 1, except on a crossfade's outgoing ghost
void main() {
  vec4 r = gl_FragCoord.x >= dxrVidSplit ? dxrVidR : dxrVidL;
  vec2 st = r.xy + vec2(vUv.x, 1.0 - vUv.y) * r.zw;
  st = clamp(st, r.xy + dxrVidTexel, r.xy + r.zw - dxrVidTexel);
  gl_FragColor = vec4(texture2D(dxrVid, st).rgb, dxrVidAlpha);
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
    this.layer = viewer.app.scene.layers.getLayerById(pc.LAYERID_WORLD ?? 0);
    this._split = NaN;
    this._build();
    /** A crossfade's outgoing quad: { mat, node, mi, tex, durationMs, ease, t0 }, or null. */
    this.ghost = null;

    this.video = null;
    this.tex = null;
    this.format = 'sbs';
    this.fit = 'contain';
    this.band = null;
    this.vH = viewer.vH;
    this._dirty = false;
    this._lastT = -1;
    this._rvfc = 0;
    this._sizeKey = '';
    this._onSeeked = () => (this._dirty = true);
    /** The picture's on-screen rect (CSS px, canvas-relative, clipped), and who wants to know. */
    this.rect = null;
    this._rectKey = '';
    this._planeSize = null;
    this._rectListeners = new Set();
    this._rectBox = null;
    this._rectPlane = null;
    this._texSource = null;
    this._eyeA = 0; // the current video's eye aspect, as last sized (the ghost's geometry)
    this._drawn = false; // sized + cropped for the current setSource's options (review N-B)
    this._texW = 0;
    this._texH = 0;
    /** How many times the rect was recomputed (a test hook for the no-per-frame-allocation promise). */
    this.rectComputes = 0;
    /** Upload accounting (handle.setVideo(...).stats()). */
    this.uploads = 0;
    this.frames = 0;
  }

  /** The quad this plane draws the current video on: material, node (under the rig), instance. */
  _build() {
    const pc = this.pc;
    const mat = new pc.ShaderMaterial({
      uniqueName: 'inline3dVideoPlane',
      attributes: { vertex_position: pc.SEMANTIC_POSITION, vertex_texCoord0: pc.SEMANTIC_TEXCOORD0 },
      vertexGLSL: VERT,
      fragmentGLSL: FRAG,
    });
    mat.cull = pc.CULLFACE_NONE;
    mat.setParameter('dxrVidSplit', Number.isFinite(this._split) ? this._split : 1e9);
    mat.setParameter('dxrVidAlpha', 1);
    mat.update();
    this.mat = mat;
    // Under the rig node: fixed relative to the eyes (see the header).
    this.node = new pc.GraphNode('inline3d-video');
    this.viewer.rigNode.addChild(this.node);
    const mi = new pc.MeshInstance(this.mesh, mat, this.node);
    mi.cull = false;
    mi.visible = false;
    this.mi = mi;
    this.layer.addMeshInstances([mi]);
  }

  /**
   * Hand the current quad, as it is, to the ghost that fades out over it, and build a fresh one for
   * the incoming video. The ghost's texture is never uploaded again, so its <video> may go.
   * (One exception, accepted: a WebGL context loss mid-fade re-uploads every texture on restore,
   * and the ghost's element may have been released by then — the ghost is blank for what is left
   * of the fade, under a second.)
   */
  _startFade({ durationMs, easing }) {
    this._dropGhost();
    this._unwatch();
    const pc = this.pc;
    const mat = this.mat;
    // Colour: over. Alpha: ONE / ONE_MINUS_SRC_ALPHA, so the buffer stays opaque where the incoming
    // quad is (1·a + 1·(1−a) = 1) and fades to the page where only the ghost is (its bars differ):
    // plain SRC_ALPHA on alpha too would leave a² + (1−a) < 1 mid-fade, and the page would show
    // through the picture.
    // (The factors are straight-alpha colour + ONE on alpha: a premultiplied result into the
    // premultipliedAlpha canvas. No guard: the 2.22.3 floor always has BlendState, and without it
    // the ghost would silently be an opaque quad with depth test off.)
    mat.blendState = new pc.BlendState(true, pc.BLENDEQUATION_ADD, pc.BLENDMODE_SRC_ALPHA, pc.BLENDMODE_ONE_MINUS_SRC_ALPHA,
      pc.BLENDEQUATION_ADD, pc.BLENDMODE_ONE, pc.BLENDMODE_ONE_MINUS_SRC_ALPHA);
    // The same plane as the incoming quad: drawn over it, never z-fighting it. The cost: for the
    // fade's length the ghost also paints over opaque page geometry IN FRONT of the screen plane
    // (a makeSbsMaterial quad, handle.engine content), which the incoming quad sits behind.
    mat.depthTest = false;
    mat.depthWrite = false;
    mat.setParameter('dxrVidAlpha', 1);
    mat.update();
    const ease = typeof easing === 'function' ? easing : EASINGS[easing] || EASINGS.linear;
    // S4: its size as a fraction of the window, so a refit (a new virtualDisplayHeight) or a resize
    // during the fade keeps the outgoing picture where it was on screen instead of jumping.
    // S4 / review R4: the ghost keeps its OWN geometry (eye aspect, fit, band) and is re-sized every
    // tick against the current window, so a refit (a new virtualDisplayHeight) or a resize mid-fade
    // keeps the outgoing picture where it was, without stretching it.
    // The eye aspect cached when this quad was last sized, NOT read off the element now: for a URL
    // source setVideo has already released the outgoing <video> (load() zeroes videoWidth), and a
    // NaN aspect would stretch the ghost over the letterbox bars for the whole fade.
    const geom = { a: this._eyeA, fit: this.fit, band: this.band };
    this.ghost = { mat, node: this.node, mi: this.mi, tex: this.tex, durationMs, ease, t0: null, geom };
    this.tex = null;
    this._texSource = null;
    this.video = null;
    this._build();
  }

  _dropGhost() {
    const g = this.ghost;
    if (!g) return;
    this.ghost = null;
    this.layer?.removeMeshInstances?.([g.mi]);
    g.mi.destroy?.(); // its reference on the shared mesh
    g.node.parent?.removeChild?.(g.node);
    g.tex?.destroy?.();
    g.mat.destroy?.();
  }

  /** One engine tick of the fade: the ghost's opacity and eye split; gone at the end. */
  _tickGhost(split) {
    const g = this.ghost;
    if (!g) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (g.t0 === null) g.t0 = now; // the clock starts on the incoming video's first drawn frame
    const x = g.durationMs > 0 ? Math.min(1, Math.max(0, (now - g.t0) / g.durationMs)) : 1;
    if (x >= 1) return this._dropGhost();
    const s = videoPlaneSize({ boxAspect: this.viewer.boxAspect, eyeAspect: g.geom.a, vH: this.vH, fit: g.geom.fit, band: g.geom.band });
    g.node.setLocalScale(s.w, s.h, 1);
    // Review R2: a page easing may overshoot (easeOutBack) or throw. Clamp it (a negative
    // ONE_MINUS_SRC_ALPHA would wreck the colours and the buffer's opacity), and a throw ends the
    // fade instead of aborting every frame's draw until it would have finished.
    let e;
    try {
      e = g.ease(x);
    } catch (err) {
      console.error('[inline3d/splat] setVideo easing threw; ending the crossfade:', err);
      return this._dropGhost();
    }
    const alpha = Number.isFinite(e) ? 1 - Math.min(1, Math.max(0, e)) : 0;
    g.mat.setParameter('dxrVidSplit', split);
    g.mat.setParameter('dxrVidAlpha', alpha);
  }

  /** True while a crossfade is running. */
  get fading() {
    return !!this.ghost;
  }

  /**
   * Play `video` on the quad (a new element, format or fit). The element must have a frame.
   * `fade` ({ durationMs, easing }): dissolve from the video now on the quad instead of cutting.
   * Returns true when a crossfade actually started.
   */
  setSource(video, { format, fit, vH, band = null }, fade = null) {
    const newElement = video !== this.video;
    // Review R1: only a video that has been DRAWN can be a ghost (it has a size, crop and a bound
    // texture). Two swaps before the next frame make the middle one a cut, never a blank quad.
    const fading = !!(fade && fade.durationMs > 0 && this.video && this.tex && this._drawn && newElement);
    if (fading) this._startFade(fade);
    else if (newElement) this._dropGhost(); // S1: a cut ends any fade still running
    if (newElement) {
      // S3: the new video has no on-screen rect until its first drawn frame.
      this.rect = null;
      this._rectKey = '';
      this._planeSize = null;
      this._eyeA = 0;
      this._rectBox = null;
    }
    this.format = format;
    this.fit = fit;
    this.vH = vH;
    this.band = band;
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
    this._drawn = false; // the quad's regions/size for these options arrive with the next draw
    return fading;
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
    // Our own record of the size the texture was made for: the real engine re-derives tex.width at
    // upload from `video.width || videoWidth`, and `video.width` is the HTML attribute, so a
    // <video width="640"> playing 1920 wide would never match and every swap would re-make it.
    if (this.tex && this._texW === w && this._texH === h) {
      // B1: same size, but maybe a different element (a cut between two same-size titles): the
      // texture must be re-pointed, or it keeps sampling the old video.
      if (this._texSource !== v) {
        this.tex.setSource?.(v);
        this._texSource = v;
        this._lastT = v.currentTime;
        this._dirty = false;
        this.uploads++;
      }
      return;
    }
    this.tex?.destroy?.();
    this._texW = w;
    this._texH = h;
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
    this._texSource = v;
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
    this._tickGhost(split);
    const boxAspect = this.viewer.boxAspect;
    const key = `${boxAspect}|${v.videoWidth}x${v.videoHeight}|${this.format}|${this.fit}|${this.vH}|${this.band}`;
    if (key !== this._sizeKey) {
      this._sizeKey = key;
      this._ensureTexture();
      const a = eyeAspect(this.format, v.videoWidth, v.videoHeight);
      this._eyeA = a;
      this._drawn = true; // sized and cropped for the current options: it can be a ghost now
      const s = videoPlaneSize({ boxAspect, eyeAspect: a, vH: this.vH, fit: this.fit, band: this.band });
      this.node.setLocalScale(s.w, s.h, 1);
      this._planeSize = { w: s.w, h: s.h, W: this.vH * boxAspect, H: this.vH };
      const crop = videoCrop({ boxAspect, eyeAspect: a, fit: this.fit, band: this.band });
      const r = eyeRegions(this.format);
      this.mat.setParameter('dxrVidL', cropRegion(r.L, crop));
      this.mat.setParameter('dxrVidR', cropRegion(r.R, crop));
    }
    this._updateRect();
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

  /** `cb(rect)` on every change of the on-screen rect; returns an unsubscribe. */
  onRect(cb) {
    // One entry per SUBSCRIPTION, not per function: the same `place` subscribed on two results (or
    // twice) must not share an entry, or the first unsubscribe would silently remove both.
    const sub = { cb };
    this._rectListeners.add(sub);
    return () => this._rectListeners.delete(sub);
  }

  /** The quad in CSS px of the canvas box, per frame; listeners hear only a change. */
  _updateRect() {
    const box = this.viewer.boxCss;
    const s = this._planeSize;
    if (!box || !s || !(box.w > 0) || !(box.h > 0)) return;
    // N3: nothing moved, nothing allocated (the viewer replaces boxCss only when it re-measures).
    if (box === this._rectBox && s === this._rectPlane) return;
    this._rectBox = box;
    this._rectPlane = s;
    this.rectComputes++;
    const r = videoScreenRect(s, box.w, box.h);
    const key = `${r.x}|${r.y}|${r.width}|${r.height}`;
    if (key === this._rectKey) return;
    this._rectKey = key;
    this.rect = r;
    for (const sub of [...this._rectListeners]) {
      // A microtask: after this draw, still inside the same rAF task (before paint), so controls
      // move in the same frame and a throw is isolated. A callback that READS layout still forces
      // layout inside the frame.
      queueMicrotask(() => {
        if (!this._rectListeners.has(sub)) return; // unsubscribed (or its video replaced) since
        try {
          sub.cb(r);
        } catch (err) {
          console.error('[inline3d/splat] onRectChange callback threw:', err);
        }
      });
    }
  }

  destroy() {
    this._rectListeners.clear();
    this._dropGhost();
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

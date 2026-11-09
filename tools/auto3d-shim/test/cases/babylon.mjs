// Babylon.js (babylon-adapter.js): an ordinary Babylon page (pages/bjs-scene.html, babylonjs 9.32.0)
// converted through the engine's own camera-rig path (two eye cameras on RIG_MODE_CUSTOM), asserted
// through the generic 'convert' checks: the right half is the left half shifted by the fake eyes' skew
// (0.1 × eye width; a wrong handedness or depth conversion breaks the shift or blanks an eye), the rig
// declares the page's FOV, and the convergence lands on the page's target / the scene.
//
//   bjs            ArcRotateCamera, no global (the Engine constructor's _gl trap); target 5 via the orbit target
//   bjs-rh         scene.useRightHandedSystem + UniversalCamera.setTarget
//   bjs-est-rev    FreeCamera with no target (the estimator) + useReverseDepthBuffer
//   bjs-global     the engine built in a later task on a context the page made: found by BABYLON.EngineStore
//   bjs-kill       Ctrl+Alt+3 off while live (mono first, the out-cover), on again on a page that stopped drawing
//   bjs-cap        the side-by-side cap (maxSbsWidth 1024 on a 1280 store): uniform scale through the
//                  hardware scaling level, back to the page's store at stand-down
//   bjs-dpr2       a page at its own CSS-pixel store on a DPR 2 viewport (the playground on the panel):
//                  the store goes to the element's device pixels (2560 x 1440), picking intact
//   bjs-gui        the same with a fullscreen GUI laid out in pixels: the page's density is kept
//   bjs-fx         DefaultRenderingPipeline (bloom, FXAA, image processing): the chain per eye
//   bjs-vp         the camera draws into the top 60 % of the canvas (Nike By You): eyes in the same
//                  sub-rectangle of each half, the page's own framing there (a marker above the axis)
//   bjs-gbuf       SSAO2 on the geometry buffer, the G-buffer drawn again for the right eye (EXPERIMENTAL);
//   bjs-gbuf-shared  ... A/B: converted WITHOUT the second draw (the right eye samples the left eye's G-buffer)
//   bjs-ss         a screen-space lookup keyed to the render target (gl_FragCoord / getRenderWidth(), the IBL
//                  shadows plugin's pattern): with eye targets each half shows the mono ramp
//   bjs-ss-direct  ... A/B: eyes drawn straight into their halves (bjsEyeTarget false): the halves split the ramp
//   bjs-gpu-ss / bjs-gpu-ss-direct  the same on a WebGPU engine (a WGSL backdrop, the WGSL eye pass)
//   bjs-dpr2 / bjs-gui  the store at the element's device pixels (DPR 2); a pixel-laid GUI keeps the page's density
//   bjs-gpu        a WebGPUEngine (the _context trap): clip z 0..1, out-cover read back from the GPU
//   bjs-gpu-kill   ... Ctrl+Alt+3 off / on again on a page that stopped drawing (replays bracketed by begin/endFrame)
//   bjs-flat-*     orthographic / two active cameras / depth of field: 2D with the reason, no session
//   bjs-product    product mode (fake host): converting -> live, the constructor trap leaves nothing behind
//   bjs-block      product mode, user block: detect-only, one { off, Babylon.js } report
//   bjs-refr       a customRenderTargets target sampled at gl_FragCoord (screen-space refraction): drawn again per eye;
//                  bjs-refr-mono (A/B, bjsCustomRT false): both eyes see the mono picture through the window
//   bjs-rt-own     v0.7.2: a customRenderTargets target drawn from a view of its own, the same for both eyes (as
//                  Babylon's ReflectiveShadowMap draws from its light): drawn once per frame, the refraction target
//                  next to it still per eye; bjs-rt-own-ab (A/B, bjsCustomRTOwnView false): drawn 3 times a frame
//   bjs-ss-late    live before any material compiled: the eye targets are tried again each second and come on
//   bjs-trap-clean a three.js page (WebGL, no Babylon): no `_gl` key on Object.prototype after the task, three converts
//   bjs-scope-*    v0.7.1: the trap is armed only by a getContext that looks like Babylon's (counted from the page:
//                  Object.defineProperty(Object.prototype, '_gl' | '_context')): 0 on three.js, PlayCanvas and a raw
//                  WebGPU page; >= 1 on Babylon WebGL / WebGPU pages, which still convert. bjs-scope-bjs-gpu-stl
//                  (v0.7.2): the same WebGPU page with Error.stackTraceLimit = 0, which keeps its limit

// Product mode: what the fake host recorded, and what the constructor trap left on Object.prototype.
const readProduct = () => {
  const H = window.__dxrFakeHost || null;
  const d = (o, k) => { const x = Object.getOwnPropertyDescriptor(o, k); return x ? { get: !!x.get, set: !!x.set, enumerable: x.enumerable, writable: x.writable } : null; };
  return {
    host: H && { loadCore: H.loadCore, reports: H.reports.map(({ status, engine, reason }) => ({ status, engine, reason })) },
    fake: { sessions: window.__fakeXR.sessions.length, layers: window.__fakeXR.layers.length },
    protoGl: d(Object.prototype, '_gl'), protoContext: d(Object.prototype, '_context'), glIn: '_gl' in {},
    engineGl: window.__engine ? { ...d(window.__engine, '_gl'), isGl: typeof WebGL2RenderingContext !== 'undefined' && window.__engine._gl instanceof WebGL2RenderingContext } : null,
  };
};

// Injected BEFORE the shim (the sentinel captures Object.defineProperty at its start, so it calls this): counts
// every '_gl' / '_context' accessor defined on Object.prototype in the document, i.e. each time the trap is armed.
const ARMS = `(() => { const dp = Object.defineProperty; const n = (window.__bjsArms = { gl: 0, context: 0 });
  Object.defineProperty = function defineProperty(o, k, d) { if (o === Object.prototype && (k === '_gl' || k === '_context')) n[k === '_gl' ? 'gl' : 'context']++; return dp.apply(this, arguments); }; })();`;

export default function cases({ P, NEW, productShim }) {
  const U = P + 'bjs-scene.html';
  const base = { shim: NEW, expect: 'convert', fovDeg: 40, ready: 'window.__frozen', timeoutMs: 30000 };
  // What state() reports for the converted canvas, on top of the generic checks.
  const babylon = (want) => (r, t, h, R) => {
    t(`Babylon.js engine found via ${want.via}`, R.engine === 'Babylon.js' && R.detection === want.via, `engine ${R.engine}, detection ${R.detection}, version ${R.version}, device ${R.device}`);
    t(`eyes on the page camera (${want.camera})`, typeof R.camera === 'string' && R.camera.includes(want.camera) && R.rigOn === 'cam', `camera ${R.camera}, rig on ${R.rigOn}`);
    if (want.handedness) t(`scene handedness ${want.handedness}`, R.handedness === want.handedness, `handedness ${R.handedness}`);
    if (want.reverse !== undefined) t(`reverse depth buffer ${want.reverse}`, R.reverseDepth === want.reverse, `reverseDepth ${R.reverseDepth}`);
    if (want.rt !== undefined) t(`eye targets ${want.rt ? 'on (each eye renders into its own target, copied into its half)' : 'off (no PostProcess class reachable: the eyes draw straight into their halves)'}`, R.eyeTargets === want.rt, `eyeTargets ${R.eyeTargets}`);
    if (want.via !== undefined && want.convVia) t(`convergence via ${want.convVia}`, R.convergenceVia === want.convVia, `via ${R.convergenceVia}`);
    if (want.pp !== undefined) t(want.pp ? 'post-processes on the camera, cascaded to the eyes' : 'no post-process on the camera', want.pp ? R.postProcesses > 0 : R.postProcesses === 0, `postProcesses ${R.postProcesses}`);
    if (!want.scaled) t('at DPR 1 the store is the page\'s own (it is already the element\'s device size)', R.real[0] === R.page.w && R.real[1] === R.page.h && R.scale === 1, `store ${R.real.join('x')}, page ${R.page.w}x${R.page.h}, scale ${R.scale}`);
  };
  // A page that must stay 2D: the reason on state(), no session ever requested.
  const flat = (id, name, q, re) => ({
    id, name, url: U + q, shim: NEW,
    async run(page, h) {
      await page.waitForFunction('window.__frozen === true', { timeout: 20000, polling: 100 }).catch(() => {});
      await h.sleep(2500);
      return page.evaluate(() => {
        const s = window.__dxrAuto3D && window.__dxrAuto3D.state();
        return { st: s ? s.renderers.map((x) => ({ engine: x.engine, active: x.active, flatReason: x.flatReason })) : null, sessions: window.__fakeXR.sessions.length };
      });
    },
    check(r, t) {
      const R = (r.st || []).find((x) => x.engine === 'Babylon.js');
      t('Babylon.js canvas seen, stays 2D with the reason', r.ok && !!R && !R.active && re.test(R.flatReason || ''), r.error || JSON.stringify(r.st));
      t('no inline-3d session requested', r.sessions === 0, `sessions ${r.sessions}`);
    },
  });
  return [
    { ...base, id: 'bjs', name: 'Babylon.js ArcRotateCamera, no global (Engine constructor _gl trap)', url: U + '?cam=arc',
      alsoCheck: babylon({ via: 'Engine constructor (_gl trap)', camera: 'ArcRotateCamera', handedness: 'left', reverse: false, convVia: 'ArcRotateCamera target', pp: 0, rt: false }) },
    // unstableBytes: on Babylon 7.54.3 only (not 8.56.2 / 9.32.0), the harness's two reads of this page differ by 1 LSB at
    // one pixel (both eyes, the same scene point). Read 90 times through ONE readback canvas, page drawing or replayed,
    // the pixel never changes: a readback artifact, not a flicker.
    { ...base, id: 'bjs-rh', name: 'Babylon.js right-handed scene, UniversalCamera.setTarget', url: U + '?cam=universal&rh=1', unstableBytes: 8,
      alsoCheck: babylon({ via: 'Engine constructor (_gl trap)', camera: 'UniversalCamera', handedness: 'right', convVia: 'camera.setTarget' }) },
    { ...base, id: 'bjs-est-rev', name: 'Babylon.js FreeCamera, no target (estimator), reverse depth buffer', url: U + '?cam=free&reverse=1',
      alsoCheck: babylon({ via: 'Engine constructor (_gl trap)', camera: 'FreeCamera', handedness: 'left', reverse: true }) },
    { ...base, id: 'bjs-global', name: 'Babylon.js engine on a context made in an earlier task: found by BABYLON.EngineStore', url: U + '?cam=arc&late=1',
      alsoCheck: babylon({ via: 'BABYLON.EngineStore.Instances', camera: 'ArcRotateCamera', rt: true }) },
    { ...base, id: 'bjs-display', name: 'Babylon.js, Ctrl+Alt+P: display rig and back, per-rig depth', url: U + '?cam=arc', displayAfter: true },
    { ...base, id: 'bjs-kill', name: 'Babylon.js, Ctrl+Alt+3 off while live, then on again (page stopped drawing)', url: U + '?cam=arc', killAfter: true, commits: true },
    { ...base, id: 'bjs-cap', name: 'Babylon.js, side-by-side cap (maxSbsWidth 1024): uniform scale via the hardware scaling level', url: U + '?cam=arc', cfg: { maxSbsWidth: 1024 }, killAfter: true, commits: true,
      // Picking while capped (CreatePickingRayToRef divides the pointer's CSS px by the hardware
      // scaling level): the canvas centre is the near sphere, as in 2D.
      probe: "(() => { const s = window.__scene, p = s.pick(640, 360); return { hit: p && p.pickedMesh ? p.pickedMesh.name : null }; })()",
      alsoCheck(r, t, h, R) {
        babylon({ via: 'Engine constructor (_gl trap)', camera: 'ArcRotateCamera', scaled: true })(r, t, h, R);
        t('picking while capped: scene.pick(canvas centre) hits the near sphere, as in 2D', r.probe && r.probe.hit === 'sphN', JSON.stringify(r.probe));
        t('store capped uniformly: 1024 x 576, hardware scaling 1.25, the page still believes 1280 x 720', R.real[0] === 1024 && R.real[1] === 576 && Math.abs(R.hwScale - 1.25) < 1e-6 && R.page.w === 1280 && R.page.h === 720,
          `store ${R.real.join('x')}, hwScale ${R.hwScale}, page ${R.page.w}x${R.page.h}, scale ${R.scale}`);
        const a = r.after;
        t('stand-down: the page\'s own store and scaling level are back', a && a.w === 1280 && a.h === 720, a ? `store after ${a.w}x${a.h}` : 'n/a');
      } },
    { ...base, id: 'bjs-dpr2', name: 'Babylon.js at its own CSS-pixel store on a DPR 2 viewport: the store goes to the device pixels through the hardware scaling level', url: U + '?cam=arc', killAfter: true, commits: true,
      before: (page) => page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 2 }),
      probe: "(() => { const s = window.__scene, p = s.pick(640, 360); return { hit: p && p.pickedMesh ? p.pickedMesh.name : null }; })()",
      alsoCheck(r, t, h, R) {
        babylon({ via: 'Engine constructor (_gl trap)', camera: 'ArcRotateCamera', scaled: true })(r, t, h, R);
        t('1280 x 720 CSS at DPR 2: store 2560 x 1440 (eye 1280 x 1440), hardware scaling 0.5; the page still believes 1280 x 720', R.real[0] === 2560 && R.real[1] === 1440 && R.eye[0] === 1280 && Math.abs(R.hwScale - 0.5) < 1e-6 && R.page.w === 1280 && R.page.h === 720 && Math.abs(R.scale - 2) < 1e-6,
          `store ${R.real.join('x')}, eye ${R.eye.join('x')}, hwScale ${R.hwScale}, page ${R.page.w}x${R.page.h}, scale ${R.scale}, follows ${R.followsResize}`);
        t('picking at the page\'s scale: scene.pick(canvas centre) hits the near sphere, as in 2D', r.probe && r.probe.hit === 'sphN', JSON.stringify(r.probe));
        const a = r.after;
        t('stand-down: the page\'s own 1280 x 720 store and scaling level are back', a && a.w === 1280 && a.h === 720, a ? `store after ${a.w}x${a.h}` : 'n/a');
      } },
    { ...base, id: 'bjs-gui', name: 'Babylon.js with a fullscreen GUI laid out in pixels, DPR 2: the page\'s density is kept (the GUI would shrink)', url: U + '?cam=arc&gui=1',
      before: (page) => page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 2 }),
      alsoCheck(r, t, h, R) {
        t('pixel GUI seen: store stays the page\'s 1280 x 720, scale 1', R.pixelGui === true && R.real[0] === 1280 && R.real[1] === 720 && R.scale === 1, `pixelGui ${R.pixelGui}, store ${R.real.join('x')}, scale ${R.scale}`);
      } },
    { ...base, id: 'bjs-vp', name: 'Babylon.js camera viewport (0, 0.4, 1, 0.6) under a configurator UI: eyes in the same sub-rectangle, the page\'s framing', url: U + '?cam=arc&vp=1',
      fovDeg: (2 * Math.atan(Math.tan((20 * Math.PI) / 180) / 0.6) * 180) / Math.PI, // the rig declares the WHOLE canvas's FOV
      probe: '(() => window.__markerY())()',
      // One pixel (both eyes, the same scene point) steps by 1 LSB once, as the harness starts reading, then
      // stays bit-stable for 90 frames; the eye matrices are bit-identical frame to frame and the page's own
      // 2D frame with this viewport is stable. Not a flicker: allowed here, not in the generic check.
      unstableBytes: 8,
      alsoCheck(r, t, h, R) {
        babylon({ via: 'Engine constructor (_gl trap)', camera: 'ArcRotateCamera' })(r, t, h, R);
        t('eye viewports follow the camera viewport', JSON.stringify(R.viewport) === JSON.stringify([0, 0.4, 1, 0.6]), `viewport ${JSON.stringify(R.viewport)}`);
        // The magenta marker's centroid in the left eye (y only: the fake skews x).
        const { px, w, h: H } = r.pixels, eyeW = R.eye[0];
        let sy = 0, n = 0, top = H, bottomRows = 0;
        for (let y = 0; y < H; y++) for (let x = 0; x < eyeW; x++) {
          const i = (y * w + x) * 4, rr = px[i], g = px[i + 1], b = px[i + 2];
          if (rr > 150 && b > 150 && g < 0.3 * Math.min(rr, b)) { sy += y; n++; }
        }
        const my = n >= 30 ? sy / n + 0.5 : NaN;
        t('the marker sits where the page\'s own camera puts it on its viewport (±3 px)', Math.abs(my - r.probe) <= 3, `left eye ${my.toFixed(1)} px (${n} px), page ${typeof r.probe === 'number' ? r.probe.toFixed(1) : r.probe}`);
        // Below the viewport (the bottom 40 %) both halves are the clear colour only: nothing drawn there.
        let drawn = 0;
        const clear = [px[(H - 2) * w * 4], px[(H - 2) * w * 4 + 1], px[(H - 2) * w * 4 + 2]];
        for (let y = Math.ceil(0.62 * H); y < H; y += 3) for (let x = 0; x < w; x += 3) { const i = (y * w + x) * 4; if (Math.abs(px[i] - clear[0]) + Math.abs(px[i + 1] - clear[1]) + Math.abs(px[i + 2] - clear[2]) > 12) drawn++; }
        t('nothing drawn below the viewport in either half', drawn === 0, `${drawn} sampled px differ from the clear colour`);
      } },
    { ...base, id: 'bjs-gbuf', name: 'Babylon.js SSAO2 on the geometry buffer: the G-buffer drawn again for the right eye (EXPERIMENTAL)', url: U + '?cam=arc&fx=ssao',
      alsoCheck(r, t, h, R) {
        babylon({ via: 'Engine constructor (_gl trap)', camera: 'ArcRotateCamera', pp: 1 })(r, t, h, R);
        t('the G-buffer was drawn for the right eye', R.gbufferPerEye > 10, `gbufferPerEye ${R.gbufferPerEye}`);
        const sh = h.bestShift(r.pixels.px, r.pixels.w, r.pixels.h, R.eye[0], 64);
        t('the pair matches tightly (each eye\'s SSAO from its own G-buffer): residual < 0.5', sh.e < 0.5, `residual ${sh.e.toFixed(3)} at shift ${sh.s}`);
      } },
    // A render target the scene draws from its camera (scene.customRenderTargets), sampled at gl_FragCoord by a
    // window in front (screen-space refraction: Nike By You's translucent parts). Drawn again per eye, the window
    // shows each eye's own view; drawn once from the page camera, both eyes see the same mono picture through it.
    { ...base, id: 'bjs-refr', name: 'Babylon.js screen-space refraction (a customRenderTargets target sampled at gl_FragCoord): drawn again for each eye', url: U + '?cam=arc&keep=1&refr=1',
      alsoCheck(r, t, h, R) {
        t("the page's render target was drawn in the eyes' passes", R.customRtPerEye > 10 && R.eyeTargets === true, `customRtPerEye ${R.customRtPerEye}, eyeTargets ${R.eyeTargets}`);
        const sh = h.bestShift(r.pixels.px, r.pixels.w, r.pixels.h, R.eye[0], 64);
        t('the pair matches tightly through the window (each eye sees its own view): residual < 0.5', sh.e < 0.5, `residual ${sh.e.toFixed(3)} at shift ${sh.s}`);
      } },
    { ...base, id: 'bjs-refr-mono', name: 'A/B: the same, the render target drawn once from the page camera (bjsCustomRT false)', url: U + '?cam=arc&keep=1&refr=1', cfg: { bjsCustomRT: false },
      alsoCheck(r, t, h, R) {
        const sh = h.bestShift(r.pixels.px, r.pixels.w, r.pixels.h, R.eye[0], 64);
        t('control: not drawn per eye, and the pair does NOT match through the window (residual > 0.5)', R.customRtPerEye === 0 && sh.e > 0.5, `customRtPerEye ${R.customRtPerEye}, residual ${sh.e.toFixed(3)} at shift ${sh.s}`);
      } },
    // A render target drawn from a view of its own, the same for both eyes (Babylon's ReflectiveShadowMap draws
    // GIRSMManager's MRT from its light). Once both eyes have drawn it with that view it is left to the scene's
    // single draw; the refraction target next to it, drawn from the camera, stays per eye.
    { ...base, id: 'bjs-rt-own', name: "Babylon.js, a customRenderTargets target drawn from a view of its own (a light's): drawn once per frame; the refraction target still per eye", url: U + '?cam=arc&keep=1&refr=1&lightrt=1&freeze=200',
      probe: '(() => window.__lightPerFrame.slice(-40))()',
      alsoCheck(r, t, h, R) {
        const last = r.probe || [];
        t('the light target recognised (one target, logged)', R.customRtOwnView === 1 && r.log.some((l) => /render target lightview draws from a view of its own/.test(l)), `customRtOwnView ${R.customRtOwnView}; ${r.log.filter((l) => /view of its own/.test(l)).join(' | ')}`);
        t('the light target drawn once per frame (the last 40 frames)', last.length === 40 && last.every((n) => n === 1), JSON.stringify(last));
        t("the refraction target still drawn in the eyes' passes", R.customRtPerEye > 10, `customRtPerEye ${R.customRtPerEye}`);
        const sh = h.bestShift(r.pixels.px, r.pixels.w, r.pixels.h, R.eye[0], 64);
        t('the pair matches tightly through the window: residual < 0.5', sh.e < 0.5, `residual ${sh.e.toFixed(3)} at shift ${sh.s}`);
      } },
    { ...base, id: 'bjs-rt-own-ab', name: 'A/B: the same, every target drawn per eye (bjsCustomRTOwnView false): the light target 3 times a frame', url: U + '?cam=arc&keep=1&refr=1&lightrt=1&freeze=200', cfg: { bjsCustomRTOwnView: false },
      probe: '(() => window.__lightPerFrame.slice(-40))()',
      alsoCheck(r, t, h, R) {
        const last = r.probe || [];
        t('control: not recognised, the light target drawn 3 times a frame', R.customRtOwnView === 0 && last.length === 40 && last.every((n) => n === 3), `customRtOwnView ${R.customRtOwnView}; ${JSON.stringify(last)}`);
      } },
    { ...base, id: 'bjs-gbuf-shared', name: 'A/B: SSAO2 on the geometry buffer, converted WITHOUT the right eye\'s G-buffer (the left eye\'s reused)', url: U + '?cam=arc&fx=ssao', cfg: { bjsGBuffer: 'shared' },
      alsoCheck(r, t, h, R) {
        const sh = h.bestShift(r.pixels.px, r.pixels.w, r.pixels.h, R.eye[0], 64);
        t('control: no right-eye G-buffer draw, and the pair does NOT match as tightly (residual > 0.5)', R.gbufferPerEye === 0 && sh.e > 0.5, `gbufferPerEye ${R.gbufferPerEye}, residual ${sh.e.toFixed(3)} at shift ${sh.s}`);
      } },
    // A screen-space lookup keyed to the render target (the IBL shadows material plugin's pattern): the
    // backdrop's red = gl_FragCoord.x / getRenderWidth(). Each eye rendered like a mono frame shows the same
    // ramp in its half; drawn straight into half the canvas, the right eye reads 0.5 -> 1, the left 0 -> 0.5.
    { ...base, id: 'bjs-ss', name: 'Babylon.js screen-space lookup (gl_FragCoord / renderTargetSize): eye targets give each eye the mono ramp', url: U + '?cam=arc&keep=1&ss=1',
      alsoCheck(r, t, h, R) {
        babylon({ via: 'Engine constructor (_gl trap)', camera: 'ArcRotateCamera', rt: true })(r, t, h, R);
        const { px, w } = r.pixels, ew = R.eye[0], red = (x) => px[(8 * w + x) * 4];
        const l = [red(4), red(ew - 5)], rr = [red(ew + 4), red(2 * ew - 5)];
        t('both halves show the same ramp: red ≈ 0 at each half\'s left edge, ≈ 255 at its right edge', Math.abs(l[0] - rr[0]) <= 4 && Math.abs(l[1] - rr[1]) <= 4 && l[0] < 12 && l[1] > 240, `left half ${l.join(' -> ')}, right half ${rr.join(' -> ')}`);
      } },
    { ...base, id: 'bjs-ss-direct', name: 'A/B: the same, eyes drawn straight into their halves (bjsEyeTarget false): the halves read different parts of the ramp', url: U + '?cam=arc&keep=1&ss=1', cfg: { bjsEyeTarget: false },
      alsoCheck(r, t, h, R) {
        const { px, w } = r.pixels, ew = R.eye[0], red = (x) => px[(8 * w + x) * 4];
        const l = [red(4), red(ew - 5)], rr = [red(ew + 4), red(2 * ew - 5)];
        t('control: no eye targets, and the right half reads the upper half of the ramp', R.eyeTargets === false && rr[0] > 100 && l[1] < 160, `left half ${l.join(' -> ')}, right half ${rr.join(' -> ')}`);
      } },
    // Live before any material compiled (meshes 1.5 s after the first frame: Nike By You on a fast load). The eye
    // targets need a compiled effect for the Effect class: they are tried again each second, then come on.
    { ...base, id: 'bjs-ss-late', name: 'Babylon.js, live before any material compiled (meshlate): the eye targets come on once one has, each eye gets the mono ramp', url: U + '?cam=arc&keep=1&ss=1&meshlate=1500&freeze=300',
      alsoCheck(r, t, h, R) {
        t('eye targets on, after a retry', R.eyeTargets === true && r.log.some((l) => /eye targets: no Effect class reachable yet/.test(l)) && r.log.some((l) => /eye targets: made on try \d+/.test(l)), `eyeTargets ${R.eyeTargets}; ${r.log.filter((l) => /eye targets/.test(l)).join(' | ')}`);
        const { px, w } = r.pixels, ew = R.eye[0], red = (x) => px[(8 * w + x) * 4];
        const l = [red(4), red(ew - 5)], rr = [red(ew + 4), red(2 * ew - 5)];
        t('both halves show the same ramp', Math.abs(l[0] - rr[0]) <= 4 && Math.abs(l[1] - rr[1]) <= 4 && l[0] < 12 && l[1] > 240, `left half ${l.join(' -> ')}, right half ${rr.join(' -> ')}`);
      } },
    // The same on a WebGPU engine (WGSL backdrop: fragmentInputs.position.x / renderTargetSize.x; WGSL eye pass).
    { ...base, id: 'bjs-gpu-ss', name: 'Babylon.js WebGPU screen-space lookup: eye targets (WGSL pass) give each eye the mono ramp', url: U + '?cam=arc&keep=1&ss=1&gpu=1', webgpu: true,
      alsoCheck(r, t, h, R) {
        t('eye targets on, on WebGPU', R.eyeTargets === true && R.device === 'webgpu', `eyeTargets ${R.eyeTargets}, device ${R.device}`);
        const { px, w } = r.pixels, ew = R.eye[0], red = (x) => px[(8 * w + x) * 4];
        const l = [red(4), red(ew - 5)], rr = [red(ew + 4), red(2 * ew - 5)];
        t('both halves show the same ramp', Math.abs(l[0] - rr[0]) <= 4 && Math.abs(l[1] - rr[1]) <= 4 && l[0] < 12 && l[1] > 240, `left half ${l.join(' -> ')}, right half ${rr.join(' -> ')}`);
      } },
    { ...base, id: 'bjs-gpu-ss-direct', name: 'A/B: the same on WebGPU, eyes drawn straight into their halves (bjsEyeTarget false)', url: U + '?cam=arc&keep=1&ss=1&gpu=1', webgpu: true, cfg: { bjsEyeTarget: false },
      alsoCheck(r, t, h, R) {
        const { px, w } = r.pixels, ew = R.eye[0], red = (x) => px[(8 * w + x) * 4];
        const l = [red(4), red(ew - 5)], rr = [red(ew + 4), red(2 * ew - 5)];
        t('control: no eye targets, the right half reads the upper half of the ramp', R.eyeTargets === false && rr[0] > 100 && l[1] < 160, `left half ${l.join(' -> ')}, right half ${rr.join(' -> ')}`);
      } },
    { ...base, id: 'bjs-fx', name: 'Babylon.js DefaultRenderingPipeline (bloom, FXAA, image processing) per eye', url: U + '?cam=arc&fx=1',
      alsoCheck: babylon({ via: 'Engine constructor (_gl trap)', camera: 'ArcRotateCamera', pp: 3, rt: true }) },
    { ...base, id: 'bjs-gpu', name: 'Babylon.js WebGPUEngine (the _context trap), ArcRotateCamera', url: U + '?cam=arc&gpu=1', webgpu: true,
      alsoCheck(r, t, h, R) {
        babylon({ via: 'WebGPUEngine (_context trap)', camera: 'ArcRotateCamera', handedness: 'left' })(r, t, h, R);
        t('WebGPU device and surface', R.device === 'webgpu' && R.surface === 'webgpu', `device ${R.device}, surface ${R.surface}`);
        // The eye projection the engine draws with maps clip z to 0..1: near -> 0 (z row = (z + w) / 2).
        const P = R.eyeProj0, n = 0.1;
        t('eye projection in WebGPU clip space (the near plane at z 0)', P && Math.abs((P[10] * n + P[14]) / (P[11] * n + P[15])) < 1e-3, P ? `z_ndc(near) = ${((P[10] * n + P[14]) / (P[11] * n + P[15])).toFixed(5)} (GL would be -1); P[10] ${P[10].toFixed(4)} P[14] ${P[14].toFixed(4)}` : 'no eyeProj0');
      } },
    { ...base, id: 'bjs-gpu-kill', name: 'Babylon.js WebGPU, Ctrl+Alt+3 off while live, then on again (page stopped drawing)', url: U + '?cam=arc&gpu=1', webgpu: true, killAfter: true, commits: true },
    flat('bjs-flat-ortho', 'Babylon.js orthographic camera stays 2D with the reason', '?cam=arc&ortho=1', /orthographic/),
    flat('bjs-flat-two', 'Babylon.js two active cameras stay 2D with the reason', '?cam=arc&two=1', /2 active cameras/),
    flat('bjs-flat-dof', 'Babylon.js depth of field (a depth renderer) stays 2D with the reason', '?cam=arc&fx=dof', /depth renderer/),
    flat('bjs-flat-taa', 'Babylon.js TAARenderingPipeline (temporal) stays 2D with the reason', '?cam=arc&fx=taa', /temporal post-process|prepass/),
    {
      id: 'bjs-product', name: 'product mode (fake host): a Babylon.js page goes live; the _gl trap leaves nothing on Object.prototype',
      url: U + '?cam=arc', shim: productShim({ decision: 'allow' }),
      async run(page, h) {
        await page.waitForFunction("(() => { const H = window.__dxrFakeHost; return !!(window.__frozen && H && H.reports.some((r) => r.status === 'live') && window.__fakeXR.frames > 90); })()", { timeout: 30000, polling: 100 });
        return { X: await page.evaluate(readProduct) };
      },
      check(r, t) {
        const X = r.X, H = X && X.host;
        t('went live, engine Babylon.js', r.ok && H && H.reports.some((x) => x.status === 'live' && x.engine === 'Babylon.js'), r.error || JSON.stringify(H && H.reports));
        t('cap.loadCore() called exactly once', H && H.loadCore === 1, `loadCore ${H && H.loadCore}`);
        t("no _gl / _context left on Object.prototype ('_gl' in {} is false)", X && X.protoGl === null && X.protoContext === null && X.glIn === false, JSON.stringify(X && { protoGl: X.protoGl, protoContext: X.protoContext, glIn: X.glIn }));
        t("the engine's own _gl is an ordinary data property holding its WebGL2 context", X && X.engineGl && !X.engineGl.get && !X.engineGl.set && X.engineGl.enumerable && X.engineGl.writable && X.engineGl.isGl, JSON.stringify(X && X.engineGl));
      },
    },
    {
      id: 'bjs-block', name: 'product mode, user block, Babylon.js: detect-only, one { off, Babylon.js } report, no trap left',
      url: U + '?cam=arc', shim: productShim({ decision: 'block' }),
      async run(page, h) {
        await page.waitForFunction('window.__frozen', { timeout: 30000, polling: 100 });
        await h.sleep(1000);
        return { X: await page.evaluate(readProduct) };
      },
      check(r, t) {
        const X = r.X, H = X && X.host;
        t('cap.loadCore() never called', r.ok && H && H.loadCore === 0, r.error || `loadCore ${H && H.loadCore}`);
        t('exactly one report: { status: off, engine: Babylon.js }', H && H.reports.length === 1 && H.reports[0].status === 'off' && H.reports[0].engine === 'Babylon.js', JSON.stringify(H && H.reports));
        t('no session', X && X.fake.sessions === 0, JSON.stringify(X && X.fake));
        t('no _gl / _context left on Object.prototype', X && X.protoGl === null && X.protoContext === null, JSON.stringify(X && { protoGl: X.protoGl, protoContext: X.protoContext }));
      },
    },
    ...[
      ['bjs-scope-three', 'three.js keyframes (WebGL)', P + 'three-keyframes.html', 'window.__frozen', false, null],
      ['bjs-scope-pc', 'PlayCanvas meshes (WebGL)', P + 'pc-mesh.html', 'window.__frozen', false, null],
      ['bjs-scope-webgpu', 'a raw WebGPU page, no engine', P + 'plain-webgpu.html', '!!document.documentElement.dataset.gpuDone', true, null],
      ['bjs-scope-bjs', 'Babylon.js WebGL', U + '?cam=arc', 'window.__frozen', false, 'gl'],
      ['bjs-scope-bjs-gpu', 'Babylon.js WebGPUEngine', U + '?cam=arc&gpu=1', 'window.__frozen', true, 'context'],
      ['bjs-scope-bjs-gpu-stl', 'Babylon.js WebGPUEngine, the page set Error.stackTraceLimit = 0', U + '?cam=arc&gpu=1&stl=0', 'window.__frozen', true, 'context'],
    ].map(([id, what, url, ready, webgpu, want]) => ({
      id, name: `product mode, trap scope: ${what} — ${want ? `the '_${want}' trap is armed, the page converts` : 'the trap is never armed'}`, url, webgpu,
      shim: [ARMS, ...productShim({ decision: 'allow' })],
      async run(page, h) {
        await page.waitForFunction(ready, { timeout: 30000, polling: 100 });
        if (want) await page.waitForFunction("(() => { const H = window.__dxrFakeHost; return !!(H && H.reports.some((r) => r.status === 'live')); })()", { timeout: 30000, polling: 100 }).catch(() => {});
        else await h.sleep(1500);
        return { arms: await page.evaluate(() => window.__bjsArms), X: await page.evaluate(readProduct), stl: await page.evaluate(() => window.__stlAfter) };
      },
      check(r, t) {
        const A = r.arms || {}, H = r.X && r.X.host;
        if (!want) t("the '_gl' / '_context' trap was never armed on this page", r.ok && A.gl === 0 && A.context === 0, r.error || JSON.stringify(A));
        else {
          t(`the '_${want}' trap was armed (a Babylon getContext)`, r.ok && A[want] >= 1, r.error || JSON.stringify(A));
          t('went live, engine Babylon.js', H && H.reports.some((x) => x.status === 'live' && x.engine === 'Babylon.js'), JSON.stringify(H && H.reports));
        }
        t('nothing left on Object.prototype', r.X && r.X.protoGl === null && r.X.protoContext === null, JSON.stringify(r.X && { protoGl: r.X.protoGl, protoContext: r.X.protoContext }));
        if (/stl=0/.test(url)) t("the page's Error.stackTraceLimit is still 0", r.stl === 0, `Error.stackTraceLimit after the engine: ${r.stl}`);
      },
    })),
    {
      id: 'bjs-trap-clean', name: 'product mode, a three.js page: no _gl trap on Object.prototype after the task (since v0.7.1 never armed: bjs-scope-three); three converts',
      url: P + 'three-keyframes.html', shim: productShim({ decision: 'allow' }),
      async run(page, h) {
        await page.waitForFunction("(() => { const H = window.__dxrFakeHost; return !!(window.__frozen && H && H.reports.some((r) => r.status === 'live')); })()", { timeout: 30000, polling: 100 });
        return { X: await page.evaluate(readProduct) };
      },
      check(r, t) {
        const X = r.X, H = X && X.host;
        t('three.js went live', r.ok && H && H.reports.some((x) => x.status === 'live' && x.engine === 'three.js'), r.error || JSON.stringify(H && H.reports));
        t('no _gl / _context left on Object.prototype', X && X.protoGl === null && X.protoContext === null && X.glIn === false, JSON.stringify(X && { protoGl: X.protoGl, protoContext: X.protoContext }));
      },
    },
  ];
}

// three.js WebGPURenderer (v0.6.1, P-W1b): the common-Renderer driver in three-adapter.js, on the real
// renderer (three@0.180.0 build/three.webgpu.js), page pages/three-webgpu-orbit.html. Cases with
// `webgpu: true` are SKIPPED (loudly) when the browser has no WebGPU adapter; the forceWebGL fallback
// case needs none. Every page frame is read in its drawing task (window.__grabFrame): a WebGPU canvas
// reads back empty once presented.
//
// What is shown:
//   three-webgpu            default output path (ACES tone mapping, sRGB: frame-buffer target + output
//                           pass): converts like a-target, eye projection = the runtime's in WebGPU clip
//                           z with coordinateSystem WebGPU, the go-live cover read back; a render()
//                           before init() is neither counted nor converted.
//   three-webgpu-raw(-ctl)  the direct path (NoToneMapping, output = working colour space): with the
//                           eye-1 clear fix both eyes survive; without it (control) eye 1's clear wipes
//                           eye 0.
//   three-webgpu-fallback   forceWebGL: the same driver on the WebGL2 backend, a WebGL surface, GL clip.
//   three-webgpu-near(-ctl) a box at 1.5 x near visible in both eyes; clipped without the conversion.
//   three-webgpu-kill       Ctrl+Alt+3 off: the out-cover is the GPU read-back of the left eye.
//   three-webgpu-postfx     PostProcessing (TSL pass()): flat with the reason, nothing converted.
//   p-three-webgpu          product mode: the real WebGPURenderer page reports live.
import { toClip, near, magenta, RECORD_IN_COVER } from './webgpu.mjs';

const WEBGL_CS = 2000, WEBGPU_CS = 2001; // THREE.WebGLCoordinateSystem / WebGPUCoordinateSystem

// The fake's GL projection for eye 0 (as fake-xr.js builds it for this canvas).
const glProbe = `(() => {
  const L = window.__fakeXR.sessionObjs.at(-1);
  const f = L._frame(); const v = f.getViewerPose().views[0];
  return { glProj0: Array.from(v.projectionMatrix), backend: window.__backend || null };
})()`;
// One pixel of an SBS frame: [r, g, b, a].
const px4 = (px, w, x, y) => { const i = (y * w + x) * 4; return [px[i], px[i + 1], px[i + 2], px[i + 3]]; };

export default function cases({ P, NEW, productShim }) {
  const settled = (minFrames = 90) => `(() => { const s = window.__dxrAuto3D && window.__dxrAuto3D.state(); const r = s && s.renderers.find((x) => x.active);
    return !!(r && r.stats.twoView > ${minFrames} && r.rampK === 1 && !r.ramping); })()`;
  // What every WebGPURenderer conversion asserts on top of the generic 'convert' checks.
  const gpuChecks = (backend, clearPath) => (r, t, h, R) => {
    const gpu = backend === 'webgpu';
    t(`WebGPURenderer driven on its ${backend} backend (surface ${gpu ? 'webgpu' : 'webgl'}), page backend agrees`,
      R.renderer === 'WebGPURenderer' && R.backend === backend && R.surface === (gpu ? 'webgpu' : 'webgl') && (!r.probe || r.probe.backend === backend),
      `renderer ${R.renderer}, backend ${R.backend}, surface ${R.surface}, page backend ${r.probe && r.probe.backend}`);
    t(`clear path '${clearPath}'`, R.clearPath === clearPath, `clearPath ${R.clearPath}`);
    t(`eye cameras carry the renderer's coordinateSystem (${gpu ? 'WebGPU' : 'WebGL'})`, R.coordinateSystem === (gpu ? WEBGPU_CS : WEBGL_CS) && R.eyeCoord0 === R.coordinateSystem,
      `renderer ${R.coordinateSystem}, eye 0 ${R.eyeCoord0}`);
    const P0 = R.eyeProj0, G = r.probe && r.probe.glProj0;
    const want = G ? (gpu ? toClip(G) : G) : null;
    t(gpu ? 'eye projection three draws with = the runtime\'s GL projection in WebGPU clip z (z row = (z + w) / 2), off-axis x / y kept (not re-derived)'
      : 'eye projection three draws with = the runtime\'s GL projection as is (WebGL2 backend)',
    P0 && want && P0.every((v, i) => near(v, want[i])),
    P0 ? `P[8] ${P0[8].toFixed(5)} (want ${want && want[8].toFixed(5)}), P[2,6,10,14] = ${[2, 6, 10, 14].map((i) => P0[i].toFixed(5)).join(', ')} (want ${want && [2, 6, 10, 14].map((i) => want[i].toFixed(5)).join(', ')})` : 'no eye projection');
    // The page's render() before init(): three warned and forwarded it; the shim did not act on it.
    t('a render() before init() passed through untouched (three\'s own warning, no shim error)', r.log.some((l) => /before the backend is initialized/.test(l)) && !r.log.some((l) => /pageerror/.test(l)),
      r.log.filter((l) => /initialized|pageerror/.test(l)).slice(0, 2).join(' | ') || 'no warning');
  };
  return [
    {
      id: 'three-webgpu', name: 'three.js WebGPURenderer (WebGPU backend, ACES + sRGB: frame-buffer target path): converts like a-target; go-live cover read back', webgpu: true,
      url: P + 'three-webgpu-orbit.html', shim: NEW, expect: 'convert', fovDeg: 40, ready: 'window.__frozen',
      probe: `(async () => ({ ...${glProbe}, inCover: await window.__inCoverStats() }))()`,
      before: (page) => page.evaluateOnNewDocument(RECORD_IN_COVER),
      alsoCheck(r, t, h, R) {
        gpuChecks('webgpu', 'fb')(r, t, h, R);
        const C = r.probe && r.probe.inCover;
        t('go-live cover: an <img> holding the mono frame (GPU read-back), one layer', !!C && C.decoded && C.std > 4 && r.fake.layers === 1,
          C ? `cover ${C.w}x${C.h}, luma mean ${C.mean.toFixed(1)} std ${C.std.toFixed(1)}; layers ${r.fake.layers}` : 'no go-live cover was inserted');
      },
    },
    {
      // The direct path: no frame-buffer target, the scene draws straight to the canvas, whose clear
      // (loadOp 'clear') ignores the scissor. The generic checks (halves differ, right = left shifted
      // 0.1 x eye) only pass when BOTH eyes survive; the corners check the clear colour in each half.
      id: 'three-webgpu-raw', name: 'three.js WebGPURenderer, NoToneMapping + linear output (direct path): both eyes survive the clears', webgpu: true,
      url: P + 'three-webgpu-orbit.html?raw=1', shim: NEW, expect: 'convert', fovDeg: 40, ready: 'window.__frozen', probe: glProbe,
      alsoCheck(r, t, h, R) {
        gpuChecks('webgpu', 'direct')(r, t, h, R);
        const { px, w } = r.pixels, ew = w / 2;
        const a = px4(px, w, 4, 4), b = px4(px, w, ew + 4, 4);
        // (0x2a3040 is an sRGB hex: three stores it linear, and this path outputs linear, unconverted.)
        t('the same opaque, non-black clear colour in the corner of BOTH halves', a[3] === 255 && b[3] === 255 && a.every((v, i) => Math.abs(v - b[i]) <= 1) && a[0] + a[1] + a[2] > 0,
          `left (${a.join(',')}), right (${b.join(',')})`);
      },
    },
    {
      id: 'three-webgpu-raw-ctl', name: 'control: the direct path WITHOUT the eye-1 clear fix: eye 1\'s clear wipes eye 0', webgpu: true,
      url: P + 'three-webgpu-orbit.html?raw=1&live=1', shim: NEW, cfg: { gpuClearFix: false },
      async run(page) {
        await page.waitForFunction(settled(60), { timeout: 60000, polling: 200 });
        const g = await page.evaluate(() => window.__grabFrame());
        const px = Buffer.from(g.b64, 'base64'), ew = g.w / 2;
        // Scene pixels per half: samples that differ from the clear colour (the top-left corner). Eye 1's
        // clear covers the whole store with it, so a wiped left eye is that colour only.
        const bg = [0, 1, 2, 3].map((k) => px[k]);
        let lc = 0, rc = 0;
        for (let y = 0; y < g.h; y += 4) for (let x = 0; x < g.w; x += 4) { const i = (y * g.w + x) * 4; if (bg.some((v, k) => Math.abs(px[i + k] - v) > 2)) { if (x < ew) lc++; else rc++; } }
        const st = await page.evaluate(() => window.__dxrAuto3D.state().renderers.find((x) => x.active));
        return { lc, rc, clearPath: st && st.clearPath };
      },
      check(r, t) {
        t('converted on the direct path', r.ok && r.clearPath === 'direct', r.error || `clearPath ${r.clearPath}`);
        t('left eye wiped (clear colour only), right eye drawn', r.ok && r.lc === 0 && r.rc > 1000, `scene samples (not the clear colour): left ${r.lc}, right ${r.rc}`);
      },
    },
    {
      // The page renders at pixel ratio 2 (a 2560x1440 mono store); the SBS store is 1280x720. three's
      // own reads of getDrawingBufferSize / getViewport / getPixelRatio (its frame-buffer target, the
      // output pass's screenUV) must see the real store while the page still sees its own.
      id: 'three-webgpu-pr2', name: 'three.js WebGPURenderer at setPixelRatio(2): three sizes its frame-buffer target and output pass from the REAL store', webgpu: true,
      url: P + 'three-webgpu-orbit.html?pr=2', shim: NEW, expect: 'convert', fovDeg: 40, ready: 'window.__frozen', probe: glProbe,
      alsoCheck(r, t, h, R) {
        gpuChecks('webgpu', 'fb')(r, t, h, R);
        t('the page sees its pixel-ratio-2 store (canvas.width 2560), the SBS store is 1280 wide', R.page.pr === 2 && R.page.canvasWidthSeenByPage === 2560 && R.real[0] === 1280, `page ${JSON.stringify(R.page)}, real ${R.real}`);
        t('no WebGPU validation error', !r.log.some((l) => /validation|GPUValidationError|Invalid/i.test(l)), r.log.filter((l) => /validation|Invalid/i.test(l)).slice(0, 2).join(' | ') || 'none');
      },
    },
    {
      id: 'three-webgpu-fallback', name: 'three.js WebGPURenderer with forceWebGL (WebGL2 backend): the same driver, GL surface, GL clip',
      url: P + 'three-webgpu-orbit.html?webgl=1', shim: NEW, expect: 'convert', fovDeg: 40, ready: 'window.__frozen', probe: glProbe,
      alsoCheck: gpuChecks('webgl2', 'fb'),
    },
    {
      // b-kill / pc-webgpu-kill for the WebGPURenderer: the out-cover is the read-back of the flat pair's
      // left eye (copyTextureToBuffer + mapAsync), right way up; the staged turn-off order holds.
      id: 'three-webgpu-kill', name: 'three.js WebGPURenderer, frozen: Ctrl+Alt+3 off (out-cover read back from the GPU), then on again', webgpu: true,
      url: P + 'three-webgpu-orbit.html', shim: NEW, expect: 'convert', fovDeg: 40, ready: 'window.__frozen', killAfter: true, commits: true,
      alsoCheck(r, t) {
        const S = r.after && r.after.state.renderers[0];
        t('out-cover pixels came from the GPU read-back (outCoverVia readback), no "could not read" warning', !!S && S.outCoverVia === 'readback' && !r.log.some((l) => /could not read the flat frame back/.test(l)),
          `outCoverVia ${S && S.outCoverVia}`);
      },
    },
    ...['', '-ctl'].map((k) => ({
      // A box at 1.5 x near (0.3 in front of a camera with near 0.2): GL clip z -0.33, outside WebGPU's
      // 0..1. Visible in both eyes only with the conversion (control: gpuDepthRange false).
      id: 'three-webgpu-near' + k,
      name: k ? 'control: three WebGPURenderer, the near box WITHOUT the depth-range conversion is clipped in both eyes' : 'three WebGPURenderer near plane: a box at 1.5 x near is visible in BOTH eyes',
      webgpu: true, url: P + 'three-webgpu-orbit.html?near=1&live=1', shim: NEW, cfg: k ? { gpuDepthRange: false } : {},
      async run(page) {
        await page.waitForFunction(settled(60), { timeout: 60000, polling: 200 });
        const g = await page.evaluate(() => window.__grabFrame());
        const st = await page.evaluate(() => window.__dxrAuto3D.state().renderers.find((x) => x.active));
        return { g: { w: g.w, h: g.h }, n: magenta(Buffer.from(g.b64, 'base64'), g.w, g.h), backend: st && st.backend, nearBox: !!(await page.evaluate(() => window.__nearBox)) };
      },
      check(r, t) {
        t('converted on the WebGPU backend, near box in the scene', r.ok && r.backend === 'webgpu' && r.nearBox, r.error || `backend ${r.backend}, nearBox ${r.nearBox}, frame ${r.g.w}x${r.g.h}`);
        const [L, Rr] = r.n || [0, 0];
        if (k) t('without the conversion the box is clipped: no magenta pixel in either eye', r.ok && L === 0 && Rr === 0, `magenta px: left ${L}, right ${Rr}`);
        else t('the box is visible in both eyes (> 200 magenta px each)', r.ok && L > 200 && Rr > 200, `magenta px: left ${L}, right ${Rr}`);
      },
    })),
    {
      id: 'three-webgpu-postfx', name: 'product mode: three.js WebGPURenderer + PostProcessing (TSL pass()) reports flat with the reason, converts nothing', webgpu: true,
      url: P + 'three-webgpu-orbit.html?postfx=1', shim: productShim({ decision: 'allow' }),
      async run(page, h) {
        await page.waitForFunction('window.__frozen', { timeout: 30000, polling: 100 });
        await page.waitForFunction("(() => { const H = window.__dxrFakeHost; return !!(H && H.reports.some((r) => r.status === 'flat')); })()", { timeout: 10000, polling: 100 }).catch(() => {});
        await h.sleep(1500);
        return {
          P: await page.evaluate(() => {
            const H = window.__dxrFakeHost || null, c = document.querySelector('canvas');
            const W = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width').get.call(c);
            return {
              host: H && { loadCore: H.loadCore, reports: H.reports.map(({ status, engine, reason }) => ({ status, engine: engine || null, reason: reason || null })) },
              fake: { sessions: window.__fakeXR.sessions.length, layers: window.__fakeXR.layers.length },
              canvasW: W, innerW: innerWidth,
            };
          }),
        };
      },
      check(r, t) {
        const X = r.P, H = X && X.host, R = (H && H.reports) || [];
        const last = R[R.length - 1];
        t('last report is flat, engine three.js, reason names WebGPU PostProcessing', r.ok && !!last && last.status === 'flat' && last.engine === 'three.js' && /WebGPU PostProcessing/.test(last.reason || ''), r.error || JSON.stringify(R));
        t('never live', !R.some((x) => x.status === 'live'), JSON.stringify(R));
        t('no layer', X && X.fake.layers === 0, JSON.stringify(X && X.fake));
        t('the canvas keeps its mono store', X && X.canvasW === X.innerW, `canvas.width ${X && X.canvasW}, innerWidth ${X && X.innerW}`);
      },
    },
    {
      id: 'p-three-webgpu', name: 'product mode (fake host): a real three.js WebGPURenderer page goes live', webgpu: true,
      url: P + 'three-webgpu-orbit.html', shim: productShim({ decision: 'allow' }),
      async run(page) {
        await page.waitForFunction("(() => { const H = window.__dxrFakeHost; return !!(window.__frozen && H && H.reports.some((r) => r.status === 'live') && window.__fakeXR.frames > 60); })()", { timeout: 30000, polling: 100 });
        return { P: await page.evaluate(() => ({ reports: window.__dxrFakeHost.reports.map(({ status, engine, reason }) => ({ status, engine: engine || null, reason: reason || null })), layers: window.__fakeXR.layers.length })) };
      },
      check(r, t) {
        const R = (r.P && r.P.reports) || [];
        t('went live (engine three.js), one layer', r.ok && R.some((x) => x.status === 'live' && x.engine === 'three.js') && r.P.layers === 1, r.error || JSON.stringify(R));
        t('never flat', !R.some((x) => x.status === 'flat'), JSON.stringify(R));
      },
    },
  ];
}

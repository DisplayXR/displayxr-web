// PlayCanvas CameraFrame per eye (v0.6.2, P-W1c): the engine's post chain (CameraFrame ->
// FramePassCameraFrame: scene -> SSAO / TAA / bloom / DOF -> compose) run once per eye, each eye into
// its own half-width targets (playcanvas-adapter.js "CameraFrame"). Before v0.6.2 the adapter stood
// down on it ('CameraFrame / frame passes on the camera — needs per-eye targets (next)').
//
// Pages (PlayCanvas 2.23.0, the engine supersplat-viewer 1.37 is built with):
//   pc-cf-mesh.html    meshes: an HDR emissive sphere (bloom), SSAO, TAA, grading, vignette on a grey
//                      clear colour; ?gpu=webgpu; ?bloom=0 / ?ssao=0 / ?taa=0 / ?vignette=0
//   pc-cf-gsplat.html  a unified gsplat under the viewer's own CameraFrame configuration (RGBA8 target,
//                      linear tone mapping, sharpening, grading, vignette, fringing); ?gpu=webgpu
//   the REAL viewer    @playcanvas/supersplat-viewer 1.37.0's standalone build (public/, engine
//                      bundled), served from .deps/supersplat-viewer/ and pointed at a generated 3 x 3
//                      splat grid (run.mjs writes .deps/gen/grid.ply) with post effects on in its
//                      settings (pages/ssv-settings.json) — so it builds its CameraFrame exactly as
//                      superspl.at does. WebGPU (its default) and ?webgl.
// Cases with `webgpu: true` are skipped (loudly) without a WebGPU adapter.
import { splatAspect } from './webgpu.mjs';

const lumAt = (px, w, x, y) => { const i = (y * w + x) * 4; return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; };
// Mean luma of a small block centred on (x, y).
function blockLum(px, w, h, x, y, r = 3) {
  let s = 0, n = 0;
  for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) { s += lumAt(px, w, xx, yy); n++; }
  return s / n;
}
// The background row at 20 % of the height (above the scene) of each eye, at 3 %, 50 % and 97 % of the eye width: a per-eye
// vignette darkens BOTH edges of each eye alike; one vignette over the pair darkens the outer edges only.
function vignetteProfile(px, w, h, e) {
  const ew = w / 2, x0 = e * ew, y = Math.round(0.2 * h);
  const at = (f) => blockLum(px, w, h, Math.round(x0 + f * ew), y);
  return { l: at(0.03), m: at(0.5), r: at(0.97) };
}
// The emissive sphere of pc-cf-mesh.html in eye e: the saturated pixels (min channel >= thr) near the
// eye's centre; its centroid and radius, and the mean luma of the ring 1.35 r .. 1.9 r around it (the
// bloom halo, over the blue box behind the sphere).
function sphere(px, w, h, e, thr = 250) {
  const ew = w / 2, x0 = e * ew;
  let n = 0, sx = 0, sy = 0;
  for (let y = Math.round(0.25 * h); y < Math.round(0.75 * h); y++) for (let x = x0 + Math.round(0.15 * ew); x < x0 + Math.round(0.85 * ew); x++) {
    const i = (y * w + x) * 4;
    if (Math.min(px[i], px[i + 1], px[i + 2]) >= thr) { n++; sx += x; sy += y; }
  }
  if (n < 50) return null;
  const cx = sx / n, cy = sy / n, r = Math.sqrt(n / Math.PI);
  let s = 0, k = 0;
  for (let a = 0; a < 64; a++) for (let f = 1.35; f <= 1.9; f += 0.05) {
    const x = Math.round(cx + f * r * Math.cos((a / 64) * 2 * Math.PI)), y = Math.round(cy + f * r * Math.sin((a / 64) * 2 * Math.PI));
    if (x < x0 || x >= x0 + ew || y < 0 || y >= h) continue;
    s += lumAt(px, w, x, y); k++;
  }
  return { cx: cx - x0, cy, r, ring: s / (k || 1) };
}
const settled = (minFrames = 90, extra = 'true') => `(() => { const s = window.__dxrAuto3D && window.__dxrAuto3D.state(); const r = s && s.renderers.find((x) => x.active);
  return !!(r && r.stats.twoView > ${minFrames} && r.rampK === 1 && !r.ramping && (${extra})); })()`;
const active = () => { const r = window.__dxrAuto3D.state().renderers.find((x) => x.active); return r ? JSON.parse(JSON.stringify(r)) : null; };
const frameOf = (g) => ({ w: g.w, h: g.h, px: Buffer.from(g.b64, 'base64'), png: g.png });
// The split, as state() describes it: both eyes on eye-sized targets, eye 0's compose clears and draws
// into the left half, eye 1's draws into the right half and clears nothing.
function splitChecks(t, R, want = {}) {
  const C = R && R.cameraFrame, E = C && C.eyes;
  const [ew, eh] = (R && R.eye) || [0, 0];
  t('CameraFrame split per eye: two chains on eye-sized targets (half the SBS store each)',
    !!E && E.length === 2 && E.every((x) => x && x.target && x.target[0] === ew && x.target[1] === eh) && C.frames > 10,
    C ? `eye targets ${E.map((x) => x && x.target && x.target.join('x')).join(' / ')} (eye ${ew}x${eh}); split frames ${C.frames}` : 'no cameraFrame in state()');
  if (!E) return;
  t('compose: eye 0 into the left half (clears), eye 1 into the right half (no clear)',
    E[0].compose && E[1].compose && E[0].compose.vp.x === 0 && E[1].compose.vp.x === ew && E[0].compose.vp.z === ew && E[1].compose.vp.z === ew && E[0].compose.clears && !E[1].compose.clears,
    JSON.stringify(E.map((x) => x.compose)));
  for (const k of Object.keys(want)) t(`each eye's chain has ${k} = ${want[k]} (the page's own option)`, E.every((x) => x[k] === want[k]), E.map((x) => `${k} ${x[k]}`).join(' / '));
  t('no stand-down reason', !R.flatReason, `flatReason ${R.flatReason}`);
}

export default function cases({ P, NEW }) {
  const meshRun = (gpu) => async (page, h) => {
    await page.waitForFunction(settled(90, 'window.__frozen'), { timeout: 60000, polling: 200 });
    const R = await page.evaluate(active);
    const g = frameOf(await page.evaluate(() => window.__grabFrame()));
    await h.sleep(300);
    const R2 = await page.evaluate(active);
    // The control: the same page with the bloom off (a fresh document; the shim is injected again).
    const u = new URL(page.url()); u.searchParams.set('bloom', '0');
    await page.goto(u.href, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(settled(90, 'window.__frozen'), { timeout: 60000, polling: 200 });
    const gNo = frameOf(await page.evaluate(() => window.__grabFrame()));
    return { R, R2, g, gNo, gpu, pixels: { png: g.png } };
  };
  const meshCheck = (r, t) => {
    if (r.error) { t('ran', false, r.error); return; }
    const { R, R2, g, gNo } = r;
    t(`converted on ${r.gpu}`, !!R && R.device === r.gpu && R.real[0] === 2 * R.eye[0], R ? `device ${R.device}, store ${R.real.join('x')}, eye ${R.eye.join('x')}` : 'not active');
    splitChecks(t, R, { taa: true, bloom: true, ssao: true });
    const j1 = R.cameraFrame && R.cameraFrame.jitter, j2 = R2 && R2.cameraFrame && R2.cameraFrame.jitter;
    t('TAA: the eyes are jittered (the engine applies none under xrViews), and the jitter moves frame to frame',
      !!j1 && !!j2 && (j1[0] !== 0 || j1[1] !== 0) && (j1[0] !== j2[0] || j1[1] !== j2[1]), `jitter ${JSON.stringify(j1)} then ${JSON.stringify(j2)} (clip units)`);
    const s = [0, 1].map((e) => sphere(g.px, g.w, g.h, e)), s0 = [0, 1].map((e) => sphere(gNo.px, gNo.w, gNo.h, e));
    const ew = g.w / 2, want = Math.round(0.1 * ew);
    t('both eyes present: the emissive sphere in each half', s[0] && s[1], s.map((x, e) => (x ? `eye ${e}: centre (${x.cx.toFixed(1)}, ${x.cy.toFixed(1)}) r ${x.r.toFixed(1)}` : `eye ${e}: none`)).join('; '));
    if (!s[0] || !s[1] || !s0[0] || !s0[1]) return;
    t(`eyes DIFFER by the fake's parallax: sphere ${want} px further right in eye 1 (±2)`, Math.abs(s[1].cx - s[0].cx - want) <= 2 && Math.abs(s[1].cy - s[0].cy) <= 1,
      `eye 1 - eye 0: dx ${(s[1].cx - s[0].cx).toFixed(2)}, dy ${(s[1].cy - s[0].cy).toFixed(2)}`);
    t('bloom glow in BOTH eyes: the ring around the sphere is brighter than with ?bloom=0 (> +8 luma each)', s[0].ring - s0[0].ring > 8 && s[1].ring - s0[1].ring > 8,
      [0, 1].map((e) => `eye ${e}: ring ${s[e].ring.toFixed(1)} vs ${s0[e].ring.toFixed(1)} without bloom`).join('; '));
    const v = [0, 1].map((e) => vignetteProfile(g.px, g.w, g.h, e));
    t('vignette per eye: both edges of EACH eye darkened alike (|outer - seam side| < 6), the eye centre brighter (> +25)',
      v.every((x) => Math.abs(x.l - x.r) < 6 && x.m - Math.max(x.l, x.r) > 25), v.map((x, e) => `eye ${e}: ${x.l.toFixed(1)} / ${x.m.toFixed(1)} / ${x.r.toFixed(1)}`).join('; '));
    t('no page error', !r.log.some((l) => /pageerror|\[error\]/.test(l)), r.log.filter((l) => /pageerror|\[error\]/.test(l)).slice(0, 2).join(' | ') || 'none');
  };

  const killCase = (gpu) => ({
    id: gpu === 'webgpu' ? 'pc-cf-webgpu-kill' : 'pc-cf-kill',
    name: `PlayCanvas CameraFrame (bloom + SSAO, no TAA / vignette) on ${gpu}: converts like b (shift, rig, convergence), Ctrl+Alt+3 off (out-cover) and on again`,
    webgpu: gpu === 'webgpu', url: P + `pc-cf-mesh.html?gpu=${gpu}&taa=0&vignette=0`, shim: NEW, expect: 'convert', fovDeg: 40, ready: 'window.__frozen', killAfter: true, commits: true,
    alsoCheck(r, t, h, R) {
      t(`device ${gpu}`, R.device === gpu, `device ${R.device}`);
      splitChecks(t, R, { taa: false, bloom: true, ssao: true });
      if (gpu === 'webgpu') {
        const S = r.after && r.after.state.renderers[0];
        t('out-cover from the GPU read-back (outCoverVia readback)', !!S && S.outCoverVia === 'readback', `outCoverVia ${S && S.outCoverVia}`);
      }
      const S = r.after && r.after.state.renderers[0];
      t('after the stand-down: camera.framePasses is the page\'s own CameraFrame pass again (no split left)', !!S && S.cameraFrame === null, `cameraFrame ${JSON.stringify(S && S.cameraFrame)}`);
    },
  });

  const gsplatCase = (gpu) => ({
    id: gpu === 'webgpu' ? 'pc-cf-gsplat-webgpu' : 'pc-cf-gsplat',
    name: `gsplat (unified) under the viewer's CameraFrame configuration on ${gpu}: split per eye, round splats in each eye`,
    webgpu: gpu === 'webgpu', url: P + `pc-cf-gsplat.html?gpu=${gpu}`, shim: NEW, fake: { pixelAspect: 2 },
    async run(page) {
      await page.waitForFunction(settled(150, 'window.__splatReady'), { timeout: 60000, polling: 200 });
      const R = await page.evaluate(active);
      const g = frameOf(await page.evaluate(() => window.__grabFrame()));
      return { R, g, pixels: { png: g.png } };
    },
    check(r, t, h) {
      if (r.error) { t('ran', false, r.error); return; }
      const { R, g } = r;
      t(`converted on ${gpu}`, !!R && R.device === gpu, R ? `device ${R.device}, store ${R.real.join('x')}` : 'not active');
      splitChecks(t, R, { taa: false, bloom: false /* RGBA8 target: the engine compiles bloom out, as on the viewer */ });
      const sh = h.bestShift(g.px, g.w, g.h, g.w / 2), want = Math.round(0.1 * (g.w / 2));
      t(`eyes differ by the fake's parallax (right = left shifted ${want} px, ±1)`, sh.zeroErr > 0.5 && Math.abs(sh.s - want) <= 1, `best shift ${sh.s} (residual ${sh.e.toFixed(2)}, ${sh.zeroErr.toFixed(2)} at 0)`);
      const a = [0, 1].map((e) => splatAspect(g.px, g.w, g.h, e));
      t('centre splat ~2:1 (tall) in store px in each eye = round on the display (pixel aspect 2)', a.every((x) => !!x && x.ratio > 1.7 && x.ratio < 2.3),
        a.map((x, e) => (x ? `eye ${e}: ${x.w}x${x.h} px, h/w ${x.ratio.toFixed(2)}` : `eye ${e}: no splat found`)).join('; ') + `; footprint patched ${R.footprint.patched}/${R.footprint.seen}`);
      t('no page error', !r.log.some((l) => /pageerror|\[error\]/.test(l)), r.log.filter((l) => /pageerror|\[error\]/.test(l)).slice(0, 2).join(' | ') || 'none');
    },
  });

  // The REAL supersplat-viewer. Its pixels are read in the drawing task through window.app (it exposes
  // the app once its first frame is drawn): a WebGPU canvas reads back empty once presented.
  const SSV = '/deps/supersplat-viewer/index.html?noui&content=/deps/gen/grid.ply&settings=' + encodeURIComponent(P + 'ssv-settings.json');
  const grabApp = () => new Promise((res) => {
    const app = window.app, canvas = app.graphicsDevice.canvas;
    app.once('postrender', () => {
      if (app.graphicsDevice.isWebGPU) app.graphicsDevice.submit();
      const W = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width').get.call(canvas);
      const H = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height').get.call(canvas);
      const c2 = document.createElement('canvas'); c2.width = W; c2.height = H;
      const g = c2.getContext('2d', { willReadFrequently: true }); g.drawImage(canvas, 0, 0);
      const d = g.getImageData(0, 0, W, H).data;
      let s = ''; for (let i = 0; i < d.length; i += 32768) s += String.fromCharCode.apply(null, d.subarray(i, i + 32768));
      res({ w: W, h: H, b64: btoa(s), png: c2.toDataURL('image/png') });
    });
    app.renderNextFrame = true;
  });
  const ssvCase = (gpu, ctl) => ({
    id: `ssv${gpu === 'webgl2' ? '-webgl' : ''}${ctl ? '-trap-ctl' : ''}`,
    name: ctl ? 'control: the real viewer WITHOUT the canvas-size trap: its own canvas.width writes pull the store back to mono every frame'
      : `the REAL supersplat-viewer 1.37 (${gpu === 'webgpu' ? 'WebGPU, its default' : '?webgl'}) with post effects: CameraFrame split per eye, store kept side by side, round splats`,
    webgpu: gpu === 'webgpu', url: SSV + (gpu === 'webgl2' ? '&webgl' : ''), shim: NEW, fake: { pixelAspect: 2 }, // maxSbsWidth 1024: the SBS store (1024 x 720) is narrower than the viewer's own store (1280 x 720), as
    // on the panel, where the 3072 cap is below the viewer's device-resolution store (3840 at 250 %): the
    // viewer then writes its size back every frame.
    cfg: ctl ? { pcCanvasTrap: false, maxSbsWidth: 1024 } : { maxSbsWidth: 1024 },
    async run(page, h) {
      if (ctl) {
        await page.waitForFunction("(() => { const s = window.__dxrAuto3D && window.__dxrAuto3D.state(); const r = s && s.renderers.find((x) => x.active); return !!(r && r.stats.twoView > 60) && !!window.app; })()", { timeout: 90000, polling: 200 });
      } else await page.waitForFunction(settled(120, '!!window.app'), { timeout: 90000, polling: 200 });
      await h.sleep(500);
      const R = await page.evaluate(active);
      const g = frameOf(await page.evaluate(grabApp));
      const deviceType = await page.evaluate(() => window.app.graphicsDevice.deviceType);
      return { R, g, deviceType, pixels: { png: g.png } };
    },
    check(r, t, h) {
      if (r.error) { t('ran', false, r.error); return; }
      const { R, g } = r;
      t(`the viewer runs on ${gpu} and converts`, !!R && R.device === gpu && r.deviceType === gpu, R ? `device ${R.device}, viewer deviceType ${r.deviceType}, detection ${R.detection}` : 'not active');
      if (!R) return;
      if (ctl) {
        t('without the trap the store does NOT stay side by side: the viewer wrote its own size back', g.w !== 2 * R.eye[0] && g.w === 1280, `canvas ${g.w}x${g.h}; the SBS store would be ${2 * R.eye[0]}x${R.eye[1]}`);
        return;
      }
      t('the viewer writes canvas.width itself; recorded as its size, the store stays side by side', R.pageSizeWrites > 0 && g.w === R.real[0] && g.w === 2 * R.eye[0] && g.h === R.eye[1],
        `page size writes ${R.pageSizeWrites}; canvas ${g.w}x${g.h}, SBS ${R.real.join('x')}, eye ${R.eye.join('x')}, page believes ${R.page.w}x${R.page.h}`);
      splitChecks(t, R, { taa: false, bloom: false /* RGBA8: highPrecisionRendering off */ });
      const sh = h.bestShift(g.px, g.w, g.h, g.w / 2), want = Math.round(0.1 * (g.w / 2));
      t(`eyes differ by the fake's parallax (right = left shifted ${want} px, ±1)`, sh.zeroErr > 0.5 && Math.abs(sh.s - want) <= 1, `best shift ${sh.s} (residual ${sh.e.toFixed(2)}, ${sh.zeroErr.toFixed(2)} at 0)`);
      const a = [0, 1].map((e) => splatAspect(g.px, g.w, g.h, e));
      t('centre splat ~2:1 (tall) in store px in each eye = round on the display', a.every((x) => !!x && x.ratio > 1.7 && x.ratio < 2.3),
        a.map((x, e) => (x ? `eye ${e}: ${x.w}x${x.h} px, h/w ${x.ratio.toFixed(2)}` : `eye ${e}: no splat found`)).join('; ') + `; footprint patched ${R.footprint.patched}/${R.footprint.seen}`);
      t('no page error', !r.log.some((l) => /pageerror/.test(l)), r.log.filter((l) => /pageerror/.test(l)).slice(0, 2).join(' | ') || 'none');
    },
  });

  return [
    killCase('webgl2'),
    killCase('webgpu'),
    { id: 'pc-cf', name: 'PlayCanvas CameraFrame, bloom + SSAO + TAA + vignette, WebGL2: per-eye post chain (glow in both eyes, vignette per eye, TAA jitter)', url: P + 'pc-cf-mesh.html?gpu=webgl2', shim: NEW, run: meshRun('webgl2'), check: meshCheck },
    { id: 'pc-cf-webgpu', name: 'the same on a WebGPU device', webgpu: true, url: P + 'pc-cf-mesh.html?gpu=webgpu', shim: NEW, run: meshRun('webgpu'), check: meshCheck },
    {
      // Approach (a), measured: xrViews under the CameraFrame as is (TEST ONLY pcCameraFrame: false). The
      // scene passes draw both views into the canvas-sized scene target, so a pair comes out, but every
      // post pass runs once over it: one vignette over the pair, bloom across the seam, one TAA history.
      id: 'pc-cf-unsplit-ctl', name: 'control (approach a): CameraFrame left UNSPLIT under xrViews: a pair comes out, but one vignette spans both eyes',
      url: P + 'pc-cf-mesh.html?gpu=webgl2&taa=0', shim: NEW, cfg: { pcCameraFrame: false },
      async run(page) {
        await page.waitForFunction(settled(90, 'window.__frozen'), { timeout: 60000, polling: 200 });
        const g = frameOf(await page.evaluate(() => window.__grabFrame()));
        return { R: await page.evaluate(active), g, pixels: { png: g.png } };
      },
      check(r, t) {
        if (r.error) { t('ran', false, r.error); return; }
        const { R, g } = r;
        t('converted, nothing split (cameraFrame null)', !!R && R.cameraFrame === null, R ? `cameraFrame ${JSON.stringify(R.cameraFrame)}` : 'not active');
        const s = [0, 1].map((e) => sphere(g.px, g.w, g.h, e, 230));
        t('both eyes are drawn (the scene passes loop over the views)', s[0] && s[1], s.map((x, e) => (x ? `eye ${e} sphere at ${x.cx.toFixed(1)}` : `eye ${e}: none`)).join('; '));
        const v = [0, 1].map((e) => vignetteProfile(g.px, g.w, g.h, e));
        t('... but the vignette is the PAIR\'s: each eye\'s seam side is brighter than its outer edge by > 30', v[0].r - v[0].l > 30 && v[1].l - v[1].r > 30,
          v.map((x, e) => `eye ${e}: ${x.l.toFixed(1)} / ${x.m.toFixed(1)} / ${x.r.toFixed(1)}`).join('; '));
      },
    },
    {
      // The page switches its CameraFrame off and on while converted: CameraFrame.disable() destroys
      // "its" framePasses (our two proxies), enable() installs a new pass, which is split again.
      id: 'pc-cf-toggle', name: 'WebGPU: the page turns its CameraFrame off, then on, while converted: plain eyes, then a new split, no stand-down', webgpu: true,
      url: P + 'pc-cf-mesh.html?gpu=webgpu&taa=0&vignette=0', shim: NEW,
      async run(page, h) {
        await page.waitForFunction(settled(90, 'window.__frozen'), { timeout: 60000, polling: 200 });
        const before = await page.evaluate(active);
        await page.evaluate(() => { window.__cf.enabled = false; });
        await h.sleep(600);
        const off = await page.evaluate(active);
        const gOff = frameOf(await page.evaluate(() => window.__grabFrame()));
        const fpOff = await page.evaluate(() => window.__cf.cameraComponent.framePasses.length);
        await page.evaluate(() => { window.__cf.enabled = true; window.__cf.update(); });
        await h.sleep(600);
        const on = await page.evaluate(active);
        const gOn = frameOf(await page.evaluate(() => window.__grabFrame()));
        return { before, off, on, gOff, gOn, fpOff, pixels: { png: gOn.png } };
      },
      check(r, t) {
        if (r.error) { t('ran', false, r.error); return; }
        const { before, off, on, gOff, gOn } = r;
        t('split while the CameraFrame is on', !!before && !!before.cameraFrame, JSON.stringify(before && before.cameraFrame && before.cameraFrame.frames));
        t('off: still converted, no split, the camera\'s framePasses empty (its pass and ours destroyed)', !!off && off.cameraFrame === null && r.fpOff === 0, `active ${!!off}, cameraFrame ${JSON.stringify(off && off.cameraFrame)}, framePasses ${r.fpOff}`);
        const so = [0, 1].map((e) => sphere(gOff.px, gOff.w, gOff.h, e, 230));
        t('off: both eyes drawn by the plain xrViews path', so[0] && so[1] && Math.abs(so[1].cx - so[0].cx - Math.round(0.1 * gOff.w / 2)) <= 2, so.map((x, e) => (x ? `eye ${e} sphere at ${x.cx.toFixed(1)}` : `eye ${e}: none`)).join('; '));
        t('on again: the NEW CameraFrame pass is split per eye, the same canvas session', !!on && !!on.cameraFrame && on.cameraFrame.frames > 5 && on.stats.twoView > before.stats.twoView, on ? `frames ${on.cameraFrame && on.cameraFrame.frames}, twoView ${before.stats.twoView} -> ${on.stats.twoView}` : 'not active');
        const s = [0, 1].map((e) => sphere(gOn.px, gOn.w, gOn.h, e));
        t('on again: both eyes, parallax', s[0] && s[1] && Math.abs(s[1].cx - s[0].cx - Math.round(0.1 * gOn.w / 2)) <= 2, s.map((x, e) => (x ? `eye ${e} sphere at ${x.cx.toFixed(1)}` : `eye ${e}: none`)).join('; '));
        const bad = /pageerror|\[error\]|back to 2D: (?!pagehide)/; // pagehide: the harness closing the page
        t('no page error, no stand-down', !r.log.some((l) => bad.test(l)), r.log.filter((l) => bad.test(l)).slice(0, 2).join(' | ') || 'none');
      },
    },
    gsplatCase('webgl2'),
    gsplatCase('webgpu'),
    ssvCase('webgpu'),
    ssvCase('webgl2'),
    ssvCase('webgl2', true),
  ];
}

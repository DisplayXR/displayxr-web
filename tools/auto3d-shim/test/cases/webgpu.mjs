// WebGPU. Two parts:
//  - three.js WebGPURenderer (corpus 2026-10-03, G1: threejs-journey / bruno-simon reported a bare
//    'idle'): product mode, the stub page announces three r185 and a WebGPURenderer on
//    __THREE_DEVTOOLS__; the core must load, report a terminal 'flat' WITH a reason, and convert
//    nothing. (The three.js WebGPURenderer driver is the next step; this case flips to 'live' then.)
//  - PlayCanvas on a WebGPU device (v0.6.0, P-W1a): the surface seam (surface.js) and the adapter on
//    WebGPU. Every case here carries `webgpu: true`: run.mjs SKIPS it (loudly) when the browser has
//    no WebGPU adapter. The pages read their canvas back in the drawing task (window.__grabFrame): a
//    WebGPU canvas reads back empty once presented.

// Column-major GL clip -> WebGPU clip z (surface.toClip): z row := (z row + w row) / 2.
const toClip = (m) => m.map((v, i) => (i % 4 === 2 ? 0.5 * (m[i] + m[i + 1]) : v));
const near = (a, b, e = 1e-5) => Math.abs(a - b) <= e * Math.max(1, Math.abs(b));

// Magenta pixels (the near-plane box) in each half of an SBS frame, and in a mono frame.
function magenta(px, w, h) {
  const n = [0, 0];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (px[i] > 180 && px[i + 1] < 90 && px[i + 2] > 180) n[x < w / 2 ? 0 : 1]++;
  }
  return n;
}

// The centre (white) splat of pc-webgpu-gsplat.html in eye e of an SBS frame: the extent of the pixels
// at >= half its peak; whiteness = the min channel (the other splats are coloured: a low min channel).
function splatAspect(px, w, h, e) {
  const ew = w / 2, x0 = e * ew;
  const m = (x, y) => { const i = (y * w + x) * 4; return Math.min(px[i], px[i + 1], px[i + 2]); };
  let peak = 0, px0 = 0, py0 = 0;
  for (let y = Math.floor(h / 2 - 60); y < h / 2 + 60; y++) for (let x = Math.floor(x0 + ew / 2 - 60); x < x0 + ew / 2 + 60; x++) { const v = m(x, y); if (v > peak) { peak = v; px0 = x; py0 = y; } }
  if (peak < 60) return null;
  let l = px0, r = px0, t = py0, b = py0;
  for (let y = Math.max(0, py0 - 120); y < Math.min(h, py0 + 120); y++) for (let x = Math.max(x0, px0 - 60); x < Math.min(x0 + ew, px0 + 60); x++) {
    if (m(x, y) >= peak / 2) { l = Math.min(l, x); r = Math.max(r, x); t = Math.min(t, y); b = Math.max(b, y); }
  }
  const W = r - l + 1, H = b - t + 1;
  return { w: W, h: H, ratio: H / W, peak };
}

// Injected before the shim: records the first go-live cover <img>; __inCoverStats() decodes and
// measures it (a blank cover would be its CSS background only).
const RECORD_IN_COVER = `(() => {
  let src = null;
  new MutationObserver((recs) => { for (const r of recs) for (const x of r.addedNodes) if (!src && x.nodeType === 1 && x.matches && x.matches('img[data-dxr-auto3d-cover]')) src = x.src; })
    .observe(document, { childList: true, subtree: true });
  window.__inCoverStats = async () => {
    if (!src) return null;
    const img = new Image(); img.src = src; let decoded = true; try { await img.decode(); } catch (e) { decoded = false; }
    const w = 128, h = 72, c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data; let m = 0, m2 = 0;
    for (let i = 0; i < d.length; i += 4) { const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; m += l; m2 += l * l; }
    const k = w * h; m /= k;
    return { srcLen: src.length, w: img.naturalWidth, h: img.naturalHeight, decoded, mean: m, std: Math.sqrt(Math.max(0, m2 / k - m * m)) };
  };
})();`;

export default function cases({ P, NEW, productShim }) {
  const settled = (minFrames = 90) => `(() => { const s = window.__dxrAuto3D && window.__dxrAuto3D.state(); const r = s && s.renderers.find((x) => x.active);
    return !!(r && r.stats.twoView > ${minFrames} && r.rampK === 1 && !r.ramping); })()`;
  // What every PlayCanvas-on-WebGPU conversion asserts on top of the generic 'convert' checks.
  const gpuChecks = (via) => (r, t, h, R) => {
    t('the page got a WebGPU device, and the adapter drives it (device webgpu, surface webgpu)', R.device === 'webgpu' && R.surface === 'webgpu', `device ${R.device}, surface ${R.surface}, page deviceType ${r.probe && r.probe.deviceType}`);
    if (via) t(`found via ${via}`, (R.detection || '').includes(via), `detection: ${R.detection}`);
    // What the engine draws eye 0 with: the runtime's (fake's) GL projection converted to clip z 0..1.
    const P0 = R.eyeProj0, G = r.probe && r.probe.glProj0;
    const want = G ? toClip(G) : null;
    t('eye projection handed to the engine = the runtime\'s GL projection in WebGPU clip z (z row = (z + w) / 2)',
      P0 && want && P0.every((v, i) => near(v, want[i])),
      P0 ? `P[2,6,10,14] = ${[2, 6, 10, 14].map((i) => P0[i].toFixed(5)).join(', ')} (want ${want && [2, 6, 10, 14].map((i) => want[i].toFixed(5)).join(', ')})` : 'no eye projection');
  };
  // The fake's GL projection for eye 0 as the shim last copied it (st.V is not exposed; rebuild it from
  // the fake's renderState + layer the way fake-xr.js does).
  const glProbe = `(() => {
    const L = window.__fakeXR.sessionObjs.at(-1), c = document.querySelector('canvas:not([data-dxr-auto3d-cover])');
    const W = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width').get.call(c), H = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height').get.call(c);
    const f = L._frame(); const v = f.getViewerPose().views[0];
    return { glProj0: Array.from(v.projectionMatrix), deviceType: window.__deviceType, W, H };
  })()`;
  return [
    {
      id: 'p-webgpu', name: 'product mode: a three.js WebGPURenderer page reports flat (WebGPU reason), converts nothing',
      url: P + 'three-webgpu.html', shim: productShim({ decision: 'allow' }),
      async run(page, h) {
        await page.waitForFunction("document.documentElement.dataset.done === '1'", { timeout: 30000, polling: 100 });
        await page.waitForFunction("(() => { const H = window.__dxrFakeHost; return !!(H && H.reports.some((r) => r.status === 'flat')); })()", { timeout: 10000, polling: 100 }).catch(() => {});
        await h.sleep(1500); // nothing may follow the flat report (no converting, no live)
        return {
          P: await page.evaluate(() => {
            const H = window.__dxrFakeHost || null, c = window.__stubRenderer && window.__stubRenderer.domElement;
            return {
              host: H && { loadCore: H.loadCore, reports: H.reports.map(({ status, engine, reason }) => ({ status, engine: engine || null, reason: reason || null })) },
              fake: { sessions: window.__fakeXR.sessions.length, layers: window.__fakeXR.layers.length },
              canvas: c ? { w: c.width, h: c.height, style: c.getAttribute('style') } : null,
            };
          }),
        };
      },
      check(r, t) {
        const X = r.P, H = X && X.host, R = (H && H.reports) || [];
        const last = R[R.length - 1];
        t('core loaded once (three announced itself)', r.ok && H && H.loadCore === 1, r.error || `loadCore ${H && H.loadCore}`);
        t('last report is flat, engine three.js, with a WebGPU reason', !!last && last.status === 'flat' && last.engine === 'three.js' && /webgpu/i.test(last.reason || ''), JSON.stringify(R));
        t('never converting / live', !R.some((x) => x.status === 'converting' || x.status === 'live'), JSON.stringify(R));
        t('no session, no layer', X && X.fake.sessions === 0 && X.fake.layers === 0, JSON.stringify(X && X.fake));
        t('the canvas is untouched (640x360, no inline style)', X && X.canvas && X.canvas.w === 640 && X.canvas.h === 360 && !X.canvas.style, JSON.stringify(X && X.canvas));
      },
    },
    {
      id: 'pc-webgpu-mesh', name: 'PlayCanvas on a WebGPU device (createGraphicsDevice + AppBase, no globals): converts like b; go-live cover read back', webgpu: true,
      url: P + 'pc-webgpu-mesh.html', shim: NEW, expect: 'convert', fovDeg: 40, ready: 'window.__frozen',
      probe: `(async () => ({ ...${glProbe}, inCover: await window.__inCoverStats() }))()`,
      before: (page) => page.evaluateOnNewDocument(RECORD_IN_COVER),
      alsoCheck(r, t, h, R) {
        gpuChecks('canvas-id trap')(r, t, h, R);
        const C = r.probe && r.probe.inCover;
        t('go-live cover: an <img> holding the mono frame (GPU read-back, not drawImage), one layer', !!C && C.decoded && C.std > 4 && r.fake.layers === 1,
          C ? `cover ${C.w}x${C.h}, luma mean ${C.mean.toFixed(1)} std ${C.std.toFixed(1)}, data URL ${C.srcLen} chars; layers ${r.fake.layers}` : 'no go-live cover was inserted');
      },
    },
    {
      // The sentinel's getContext('webgpu') arming, alone: the canvas is created by script and is not in
      // the document until the app exists (no readystatechange arming, no observer arming), and there
      // are no globals. On WebGL (s-pc-dyn) the id is read before the context and the app stays 2D; on
      // WebGPU the context comes first, so the trap catches the AppBase constructor.
      id: 'pc-webgpu-dyn', name: "PlayCanvas WebGPU on a script-created canvas inserted after the app exists: found through the getContext('webgpu') trap", webgpu: true,
      url: P + 'pc-webgpu-mesh.html?dyn=1', shim: NEW, expect: 'convert', fovDeg: 40, ready: 'window.__frozen', probe: glProbe,
      alsoCheck: gpuChecks('canvas-id trap'),
    },
    {
      // b-kill on WebGPU: the out-cover is the GPU read-back of the flat pair's left eye
      // (copyTextureToBuffer + mapAsync), not drawImage; the staged turn-off order holds (commit model).
      id: 'pc-webgpu-kill', name: 'PlayCanvas WebGPU, frozen: Ctrl+Alt+3 off (out-cover read back from the GPU), then on again', webgpu: true,
      url: P + 'pc-webgpu-mesh.html', shim: NEW, expect: 'convert', fovDeg: 40, ready: 'window.__frozen', killAfter: true, commits: true,
      alsoCheck(r, t) {
        const S = r.after && r.after.state.renderers[0];
        t('out-cover pixels came from the GPU read-back (outCoverVia readback), no "could not read" warning', !!S && S.outCoverVia === 'readback' && !r.log.some((l) => /could not read the flat frame back/.test(l)),
          `outCoverVia ${S && S.outCoverVia}`);
      },
    },
    ...['', '-ctl'].map((k) => ({
      // An object at 1.5 × near (0.3 in front of a camera whose near plane is 0.2). In GL clip z it is at
      // 1 - 2n/d = -0.33: inside GL's -1..1, OUTSIDE WebGPU's 0..1. Visible in both eyes only with
      // surface.toClip; the control hands the engine the GL matrix (gpuDepthRange: false) and loses it.
      id: 'pc-webgpu-near' + k,
      name: k ? 'control: the same near box WITHOUT the depth-range conversion is clipped in both eyes' : 'near plane: a box at 1.5 x near is visible in BOTH eyes (WebGPU depth-range conversion)',
      webgpu: true, url: P + 'pc-webgpu-mesh.html?near=1&live=1', shim: NEW, cfg: k ? { gpuDepthRange: false } : {},
      async run(page) {
        await page.waitForFunction(settled(60), { timeout: 60000, polling: 200 });
        const g = await page.evaluate(() => window.__grabFrame());
        const st = await page.evaluate(() => window.__dxrAuto3D.state().renderers.find((x) => x.active));
        return { g: { w: g.w, h: g.h }, n: magenta(Buffer.from(g.b64, 'base64'), g.w, g.h), dev: st && st.device, nearBox: !!(await page.evaluate(() => window.__nearBox)) };
      },
      check(r, t) {
        t('converted on a WebGPU device, near box in the scene', r.ok && r.dev === 'webgpu' && r.nearBox, r.error || `device ${r.dev}, nearBox ${r.nearBox}, frame ${r.g.w}x${r.g.h}`);
        const [L, Rr] = r.n || [0, 0];
        if (k) t('without the conversion the box is clipped: no magenta pixel in either eye', r.ok && L === 0 && Rr === 0, `magenta px: left ${L}, right ${Rr}`);
        else t('the box is visible in both eyes (> 200 magenta px each)', r.ok && L > 200 && Rr > 200, `magenta px: left ${L}, right ${Rr}`);
      },
    })),
    ...[['', ''], ['-ctl', ''], ['-cpu', '?cpuSort=1']].map(([k, qs]) => ({
      // Round splats seen through an eye whose store pixel is twice as wide as tall (fake pixelAspect 2,
      // as on the panel): with the WGSL footprint fix the centre splat is ~2x as tall as wide in store
      // pixels, i.e. ROUND on the display; without it (control: pcFootprint false) the engine's single
      // focal makes it ~1:1 in store pixels = HALF HEIGHT on the display.
      id: 'pc-webgpu-gsplat' + k,
      name: k === '-ctl' ? 'control: gsplat on WebGPU WITHOUT the WGSL footprint fix: splats at half height'
        : `gsplat on WebGPU (${qs ? 'RASTER_CPU_SORT: the raster WGSL chunk' : 'GPU sort: the compute projector'}): WGSL footprint fix, round splats in each eye`,
      webgpu: true, url: P + 'pc-webgpu-gsplat.html' + qs, shim: NEW, expect: 'convert', fovDeg: 50, ready: 'window.__splatReady', minFrames: 150,
      fake: { pixelAspect: 2 }, cfg: k === '-ctl' ? { pcFootprint: false } : {},
      alsoCheck(r, t, h, R) {
        t('WebGPU device', R.device === 'webgpu', `device ${R.device}`);
        const fp = R.footprint;
        if (k === '-ctl') t('footprint fix off: no shader patched', fp.patched === 0, `${fp.patched}/${fp.seen}`);
        else t('WGSL footprint shader patched (>= 1)', fp.patched >= 1 && fp.seen >= 1, `patched ${fp.patched} of ${fp.seen} splat module(s) seen`);
        const a = [0, 1].map((e) => splatAspect(r.pixels.px, r.pixels.w, r.pixels.h, e));
        const ok = (x) => !!x && (k === '-ctl' ? x.ratio > 0.8 && x.ratio < 1.25 : x.ratio > 1.7 && x.ratio < 2.3);
        t(k === '-ctl' ? 'centre splat ~1:1 in store px in each eye (half height on the display)' : 'centre splat ~2:1 (tall) in store px in each eye = round on the display (pixel aspect 2)', ok(a[0]) && ok(a[1]),
          a.map((x, e) => (x ? `eye ${e}: ${x.w}x${x.h} px, h/w ${x.ratio.toFixed(2)}` : `eye ${e}: no splat found`)).join('; '));
      },
    })),
  ];
}

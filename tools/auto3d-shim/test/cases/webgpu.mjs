// three.js WebGPURenderer (corpus 2026-10-03, G1: threejs-journey / bruno-simon reported a bare
// 'idle'). Product mode: the stub page announces three r185 and a WebGPURenderer on
// __THREE_DEVTOOLS__; the core must load, report a terminal 'flat' WITH a reason, and convert nothing.
export default function cases({ P, productShim }) {
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
  ];
}

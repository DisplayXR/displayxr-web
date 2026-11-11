// PlayCanvas engine versions, side by side (v0.7.4). Sites ship whatever 2.x engine they were built
// with (superspl.at 2.23.0, others 2.22.x and older), and playcanvas.com/examples runs 2.24.0, whose
// CameraFrame is CameraFrameEffect-based and whose FrameGraph.addPass skips a disabled pass's subtree.
// Every adapter path is feature-detected; these cases pin the engine per case, so one harness run covers
// several: the page is served under /pc-<X.Y>/ with every PlayCanvas import pointed at
// .deps/playcanvas-<X.Y> (run.mjs serve(); deps.mjs stages 2.24.0, 2.20.6 and 2.17.2).
//
// Each case is an existing case (same driver, same assertions) on another engine, id `<case>@<X.Y>`:
//   2.24  the CameraFrame split (one chain run per eye: effects own their passes), its on/off toggle
//         (disable() filters the page's pass out and leaves our proxies), a gsplat under CameraFrame,
//         the native per-axis splat focal (footprint.native, no patch needed), the plain mesh page.
//   2.20  the oldest engine with Camera.xrViews: the mesh page and the CameraFrame pair split.
//   2.17  no Camera.xrViews (and no tick / graphicsDevice in the AppBase constructor): found, and left
//         2D with the reason, no page error.
import cameraframe from './cameraframe.mjs';
import existing from './existing.mjs';
import webgpu from './webgpu.mjs';

export default function cases(env) {
  const all = [...existing(env), ...cameraframe(env), ...webgpu(env)];
  const pin = (id, v, extra = {}) => {
    const c = all.find((x) => x.id === id);
    if (!c) throw new Error(`pc-engines: no case '${id}'`);
    const { suffix = '', path = c.url, ...rest } = extra;
    return { ...c, ...rest, id: `${id}${suffix}@${v}`, name: `[PlayCanvas ${v}]${suffix ? ' (' + path.split('?')[1] + ')' : ''} ${c.name}`, url: `/pc-${v}${path}` };
  };
  return [
    pin('b', '2.24'),
    pin('pc-cf', '2.24'),
    pin('pc-cf-webgpu', '2.24'),
    pin('pc-cf-toggle', '2.24'),
    // The examples' default: an MSAA back buffer (antialias true). Before v0.7.4's store fix eye 0 came
    // out black under the one-chain split (compute/texture-gen, vertex-update, indirect-draw on 2.24).
    pin('pc-cf', '2.24', { suffix: '-aa', path: `${env.P}pc-cf-mesh.html?gpu=webgl2&aa=1` }),
    pin('pc-cf-webgpu', '2.24', { suffix: '-aa', path: `${env.P}pc-cf-mesh.html?gpu=webgpu&aa=1` }),
    pin('pc-cf-gsplat', '2.24'),
    pin('pc-webgpu-gsplat', '2.24'),
    // TAA under the one-chain split: the pass keeps ONE history pair, which eye 1 writes last, so eye 0
    // is given its own history (copied aside after its resolve). Measured as the pair residual at the
    // fake's 0.1 x eyeW shift on a frozen scene: with eye 0 reading eye 1's history (ctl,
    // pcTaaEyeHistory false) eye 0 resolves against a picture 64 px off and the eyes disagree.
    ...[['', {}], ['-ctl', { pcTaaEyeHistory: false }]].map(([k, cfg]) => ({
      id: `pc-cf-taa${k}@2.24`,
      name: k ? '[PlayCanvas 2.24] control: TAA with ONE history for both eyes (eye 0 reads eye 1\'s): the eyes disagree'
        : '[PlayCanvas 2.24] TAA per eye under the one-chain split: eye 0 has its own history, the eyes agree',
      url: `/pc-2.24${env.P}pc-cf-mesh.html?gpu=webgl2&bloom=0&ssao=0&vignette=0`, shim: env.NEW, cfg,
      async run(page, h) {
        await page.waitForFunction(`(() => { const s = window.__dxrAuto3D && window.__dxrAuto3D.state(); const r = s && s.renderers.find((x) => x.active);
          return !!(r && r.stats.twoView > 150 && r.rampK === 1 && !r.ramping && window.__frozen); })()`, { timeout: 60000, polling: 200 });
        await h.sleep(500);
        const g = await page.evaluate(() => window.__grabFrame());
        const R = await page.evaluate(() => JSON.parse(JSON.stringify(window.__dxrAuto3D.state().renderers.find((x) => x.active))));
        return { R, g: { w: g.w, h: g.h, px: Buffer.from(g.b64, 'base64') }, pixels: { png: g.png } };
      },
      check(r, t, h) {
        if (r.error) { t('ran', false, r.error); return; }
        const { R, g } = r, cf = R.cameraFrame;
        t('one chain run per eye, with TAA', !!cf && cf.mode === 'shared' && cf.eyes[0].taa && cf.frames > 100, JSON.stringify(cf && { mode: cf.mode, taa: cf.eyes[0].taa, frames: cf.frames }));
        const ew = g.w / 2, want = Math.round(0.1 * ew), sh = h.bestShift(g.px, g.w, g.h, ew, want);
        let e = 0, n = 0; // the residual AT the expected shift (bestShift's own minimum may sit elsewhere)
        for (let y = 0; y < g.h; y += 2) for (let x = 0; x < ew - want; x += 2) { e += Math.abs(h.lum(g.px, (y * g.w + x) * 4) - h.lum(g.px, (y * g.w + ew + x + want) * 4)); n++; }
        const at = e / n;
        if (k) t('eye 0 resolves against eye 1\'s history: residual at the shift > 0.3', at > 0.3, `residual ${at.toFixed(2)} at ${want} px (best ${sh.s} px: ${sh.e.toFixed(2)})`);
        else t('the eyes agree: residual at the shift < 0.2', at < 0.2 && Math.abs(sh.s - want) <= 1, `residual ${at.toFixed(2)} at ${want} px (best ${sh.s} px: ${sh.e.toFixed(2)})`);
        t('no page error', !r.log.some((l) => /pageerror|\[error\]/.test(l)), r.log.filter((l) => /pageerror|\[error\]/.test(l)).slice(0, 2).join(' | ') || 'none');
      },
    })),
    // Screen-space UI only: nothing has depth, left 2D with the reason (on 2.22.3, the default engine,
    // and on 2.24, the examples'); the same page once it adds a 3D box converts.
    ...['', '/pc-2.24'].map((pre) => ({
      id: `pc-ui-only${pre ? '@2.24' : ''}`, name: `${pre ? '[PlayCanvas 2.24] ' : ''}PlayCanvas screen-space UI only (no mesh, no splat): left 2D, 'nothing 3D', no layer`,
      url: `${pre}${env.P}pc-ui.html`, shim: env.NEW,
      async run(page, h) {
        await page.waitForFunction(() => window.__frozen, { timeout: 30000, polling: 200 });
        await h.sleep(3000);
        return { S: await page.evaluate(() => window.__dxrAuto3D.state()), layers: await page.evaluate(() => window.__fakeXR.layers.length) };
      },
      check(r, t) {
        if (r.error) { t('ran', false, r.error); return; }
        const R = r.S.renderers.find((x) => x.engine === 'PlayCanvas');
        t('PlayCanvas app found, left 2D: nothing 3D', !!R && !R.active && /nothing 3D/.test(R.flatReason || '') && r.layers === 0, `active ${R && R.active}, flatReason ${R && R.flatReason}, layers ${r.layers}`);
        t('no page error', !r.log.some((l) => /pageerror|\[error\]/.test(l)), r.log.filter((l) => /pageerror|\[error\]/.test(l)).slice(0, 2).join(' | ') || 'none');
      },
    })),
    // The same page with MiniStats on (the examples site's stats toggle): its quad batch is screen-space,
    // so the page stays 2D, and the "stays 2D" reason is logged ONCE (it was re-logged ~2x/s, every
    // activation attempt). MiniStats joins the UI layer as a mesh instance (2.21+) or draws as an
    // immediate mesh (2.20).
    ...['', '/pc-2.24', '/pc-2.20'].map((pre) => ({
      id: `pc-ui-stats${pre ? '@' + pre.slice(4) : ''}`, name: `${pre ? `[PlayCanvas ${pre.slice(4)}] ` : ''}PlayCanvas screen-space UI + MiniStats: still 2D ('nothing 3D'), the reason logged once`,
      url: `${pre}${env.P}pc-ui.html?stats=1`, shim: env.NEW,
      async run(page, h) {
        await page.waitForFunction(() => window.__frozen, { timeout: 30000, polling: 200 });
        await h.sleep(4000);
        return { S: await page.evaluate(() => window.__dxrAuto3D.state()), layers: await page.evaluate(() => window.__fakeXR.layers.length), stats: await page.evaluate(() => !!window.__stats) };
      },
      check(r, t) {
        if (r.error) { t('ran', false, r.error); return; }
        const R = r.S.renderers.find((x) => x.engine === 'PlayCanvas');
        t('MiniStats on, left 2D: nothing 3D', r.stats && !!R && !R.active && /nothing 3D/.test(R.flatReason || '') && r.layers === 0, `stats ${r.stats}, active ${R && R.active}, flatReason ${R && R.flatReason}, layers ${r.layers}`);
        const n = r.log.filter((l) => /stays 2D/.test(l)).length;
        t('"stays 2D" logged once over 4+ s', n === 1, `${n} lines`);
        t('no page error', !r.log.some((l) => /pageerror|\[error\]/.test(l)), r.log.filter((l) => /pageerror|\[error\]/.test(l)).slice(0, 2).join(' | ') || 'none');
      },
    })),
    {
      id: 'pc-ui-lines', name: 'PlayCanvas screen-space UI + immediate-mode lines (app.drawLine): that is 3D, converts',
      url: `${env.P}pc-ui.html?lines=1`, shim: env.NEW,
      async run(page) {
        await page.waitForFunction(() => { const r = window.__dxrAuto3D && window.__dxrAuto3D.state().renderers.find((x) => x.active); return !!(r && r.stats.twoView > 30); }, { timeout: 20000, polling: 200 });
        return { R: await page.evaluate(() => window.__dxrAuto3D.state().renderers.find((x) => x.active)) };
      },
      check(r, t) { t('converted', !r.error && !!r.R && r.R.stats.twoView > 30, r.error || `twoView ${r.R && r.R.stats.twoView}`); },
    },
    {
      id: 'pc-ui-then-3d', name: 'PlayCanvas screen-space UI, then the page adds a 3D box (4 s): converts once there is depth',
      url: `${env.P}pc-ui.html?add3dMs=4000`, shim: env.NEW,
      async run(page) {
        await page.waitForFunction(() => window.__frozen && performance.now() > 2500, { timeout: 30000, polling: 100 });
        const before = await page.evaluate(() => ({ ...(window.__dxrAuto3D.state().renderers.find((x) => x.engine === 'PlayCanvas') || {}), added: !!window.__added3d }));
        await page.waitForFunction(() => window.__added3d, { timeout: 30000, polling: 100 });
        await page.waitForFunction(() => { const r = window.__dxrAuto3D.state().renderers.find((x) => x.active); return !!(r && r.stats.twoView > 30); }, { timeout: 20000, polling: 200 });
        return { before, after: await page.evaluate(() => window.__dxrAuto3D.state().renderers.find((x) => x.active)) };
      },
      check(r, t) {
        if (r.error) { t('ran', false, r.error); return; }
        t('2D while UI only (nothing 3D)', !!r.before && !r.before.added && !r.before.active && /nothing 3D/.test(r.before.flatReason || ''), `flatReason ${r.before && r.before.flatReason}`);
        t('3D once the box is there', !!r.after && r.after.stats.twoView > 30, `twoView ${r.after && r.after.stats.twoView}`);
      },
    },
    pin('b', '2.20'),
    pin('pc-cf', '2.20'),
    {
      id: 'b@2.17', name: '[PlayCanvas 2.17] meshes: the app is found from its constructor, then left 2D (no Camera.xrViews), no page error',
      url: `/pc-2.17${env.P}pc-mesh.html`, shim: env.NEW,
      async run(page, h) {
        await page.waitForFunction(() => window.__frozen, { timeout: 30000, polling: 200 });
        await h.sleep(2500);
        return { S: await page.evaluate(() => window.__dxrAuto3D.state()), reps: await page.evaluate(() => window.__dxrAuto3DReports || []), layers: await page.evaluate(() => window.__fakeXR.layers.length) };
      },
      check(r, t) {
        if (r.error) { t('ran', false, r.error); return; }
        const R = r.S.renderers.find((x) => x.engine === 'PlayCanvas');
        t('PlayCanvas app found (AppBase constructor trap, before init())', r.S.playcanvas.detected.length > 0 && !!R, `detected ${JSON.stringify(r.S.playcanvas.detected)}`);
        t('left 2D, with the reason', !!R && !R.active && /Camera\.xrViews/.test(R.flatReason || '') && r.layers === 0, `active ${R && R.active}, flatReason ${R && R.flatReason}, layers ${r.layers}`);
        const last = r.reps[r.reps.length - 1];
        t('reported flat (PlayCanvas)', !!last && last.status === 'flat' && last.engine === 'PlayCanvas', JSON.stringify(last));
        t('no page error', !r.log.some((l) => /pageerror|\[error\]/.test(l)), r.log.filter((l) => /pageerror|\[error\]/.test(l)).slice(0, 2).join(' | ') || 'none');
      },
    },
  ];
}

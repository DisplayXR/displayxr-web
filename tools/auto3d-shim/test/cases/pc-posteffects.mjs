// PlayCanvas LEGACY post effects per eye (v0.7.9, #319): camera.postEffects, the engine's
// PostEffectQueue (what PlayCanvas Editor apps use: posteffect-bloom.js and friends). Before v0.7.9 the
// adapter stood down on it ('post effects on the camera — needs per-eye targets (next)'): the queue
// gives the camera a render target of its own, and a camera with a render target was not a canvas camera.
// Now both eyes render side by side into the queue's input target and the page's chain runs once per
// eye over an eye-sized copy, the last effect into the eye's half (playcanvas-adapter.js "legacy post
// effects").
//
// Page: pc-postfx.html, two pc.PostEffect subclasses (a bloom with its own half-size targets, then a
// vignette), so the queue holds a chain. Engines: 2.22.3 (the page's import map), and pinned 2.20
// (the oldest with Camera.xrViews) and 2.24; WebGL2 and WebGPU (the page's effects carry WGSL too).
// Cases with `webgpu: true` are skipped (loudly) without a WebGPU adapter.
import { active, frameOf, settled, sphere, vignetteProfile } from './cameraframe.mjs';

const errs = (r, re = /pageerror|\[error\]/) => r.log.filter((l) => re.test(l));

export default function cases({ P, NEW }) {
  const url = (pre, qs) => `${pre}${P}pc-postfx.html?${qs}`;
  const grab = async (page) => frameOf(await page.evaluate(() => window.__grabFrame()));
  const fxState = (page) => page.evaluate(() => ({
    resizes: window.__fx.bloom.resizes, bloomTarget: window.__fx.bloom.targets[0] ? [window.__fx.bloom.targets[0].width, window.__fx.bloom.targets[0].height] : null,
    rt: window.__camera.renderTarget ? window.__camera.renderTarget.name || window.__camera.renderTarget.colorBuffer.name : null,
  }));

  const runMain = (gpu) => async (page, h) => {
    await page.waitForFunction(settled(90, 'window.__frozen'), { timeout: 60000, polling: 200 });
    const R = await page.evaluate(active);
    const g = await grab(page);
    await h.sleep(300);
    const R2 = await page.evaluate(active);
    const fx = await fxState(page);
    // The control: the same page without the bloom (a fresh document; the shim is injected again).
    const u = new URL(page.url()); u.searchParams.set('bloom', '0');
    await page.goto(u.href, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(settled(90, 'window.__frozen'), { timeout: 60000, polling: 200 });
    const gNo = await grab(page);
    return { R, R2, g, gNo, fx, gpu, pixels: { png: g.png } };
  };
  const checkMain = (want = {}) => (r, t) => {
    if (r.error) { t('ran', false, r.error); return; }
    const { R, R2, g, gNo, fx } = r;
    t(`converted on ${r.gpu}`, !!R && R.device === r.gpu && R.real[0] === 2 * R.eye[0], R ? `device ${R.device}, store ${R.real.join('x')}, eye ${R.eye.join('x')}` : 'not active');
    if (!R) return;
    const pe = R.postEffects, [ew, eh] = R.eye;
    t('the queue\'s chain runs per eye: two effects, the camera\'s post-processing hook is ours, the queue\'s input target is the side-by-side store',
      !!pe && pe.effects.length === 2 && pe.hooked && pe.source && pe.source[0] === R.real[0] && pe.source[1] === R.real[1],
      pe ? `effects ${pe.effects.join(' -> ')}; hooked ${pe.hooked}; queue target ${pe.source && pe.source.join('x')} (x${pe.samples}), store ${R.real.join('x')}` : 'no postEffects in state()');
    if (!pe) return;
    t('one eye-sized target per effect; every frame through the per-eye chain (none through the page\'s own over the pair)',
      pe.eye.length === 2 && pe.eye.every((x) => x[0] === ew && x[1] === eh) && pe.frames > 10 && pe.mono === 0 && R2.postEffects.frames > pe.frames,
      `eye targets ${pe.eye.map((x) => x.join('x')).join(' / ')} (eye ${ew}x${eh}); per-eye frames ${pe.frames} -> ${R2.postEffects.frames}, over the pair ${pe.mono}`);
    if ('samples' in want) t(`the queue's input target is ${want.samples > 1 ? 'multisampled (the eye copy reads its resolve)' : 'single-sampled'}`, want.samples > 1 ? pe.samples > 1 : pe.samples <= 1, `samples ${pe.samples}`);
    t('the bloom sized its own targets from the EYE input once (not rebuilt per eye or per frame)', fx.resizes <= 3 && !!fx.bloomTarget && fx.bloomTarget[0] === ew >> 1 && fx.bloomTarget[1] === eh >> 1,
      `bloom targets ${fx.bloomTarget && fx.bloomTarget.join('x')} (half of ${ew}x${eh}), rebuilt ${fx.resizes} times since load`);
    t('no stand-down reason', !R.flatReason, `flatReason ${R.flatReason}`);
    const s = [0, 1].map((e) => sphere(g.px, g.w, g.h, e)), s0 = [0, 1].map((e) => sphere(gNo.px, gNo.w, gNo.h, e));
    const want10 = Math.round(0.1 * (g.w / 2));
    t('both eyes present: the emissive sphere in each half', s[0] && s[1], s.map((x, e) => (x ? `eye ${e}: centre (${x.cx.toFixed(1)}, ${x.cy.toFixed(1)}) r ${x.r.toFixed(1)}` : `eye ${e}: none`)).join('; '));
    if (!s[0] || !s[1] || !s0[0] || !s0[1]) return;
    t(`eyes DIFFER by the fake's parallax: sphere ${want10} px further right in eye 1 (±2)`, Math.abs(s[1].cx - s[0].cx - want10) <= 2 && Math.abs(s[1].cy - s[0].cy) <= 1,
      `eye 1 - eye 0: dx ${(s[1].cx - s[0].cx).toFixed(2)}, dy ${(s[1].cy - s[0].cy).toFixed(2)}`);
    t('bloom glow in BOTH eyes: the ring around the sphere is brighter than with ?bloom=0 (> +8 luma each), and alike (within 4)',
      s[0].ring - s0[0].ring > 8 && s[1].ring - s0[1].ring > 8 && Math.abs(s[0].ring - s[1].ring) < 4,
      [0, 1].map((e) => `eye ${e}: ring ${s[e].ring.toFixed(1)} vs ${s0[e].ring.toFixed(1)} without bloom`).join('; '));
    const v = [0, 1].map((e) => vignetteProfile(g.px, g.w, g.h, e));
    t('vignette per eye: both edges of EACH eye darkened alike (|outer - seam side| < 6), the eye centre brighter (> +25)',
      v.every((x) => Math.abs(x.l - x.r) < 6 && x.m - Math.max(x.l, x.r) > 25), v.map((x, e) => `eye ${e}: ${x.l.toFixed(1)} / ${x.m.toFixed(1)} / ${x.r.toFixed(1)}`).join('; '));
    t('no page error', !errs(r).length, errs(r).slice(0, 2).join(' | ') || 'none');
  };
  const main = (id, name, pre, gpu, qs = '', want = {}) => ({
    id, name, webgpu: gpu === 'webgpu', url: url(pre, `gpu=${gpu}${qs}`), shim: NEW, run: runMain(gpu), check: checkMain(want),
  });

  // Stays 2D, with the reason on the HUD and in state().
  const flat = (id, name, qs, re, cfg) => ({
    id, name, url: url('', qs), shim: NEW, cfg, expect: 'flat', ready: 'window.__frozen',
    check(r, t) {
      const S = r.state && r.state.renderers[0];
      t('no session requested, nothing converted', r.fake.sessions === 0 && S && !S.active && !S.pending, `sessions ${r.fake.sessions}, active ${S && S.active}`);
      t('flat with the reason (state, HUD)', S && re.test(S.flatReason || '') && re.test(r.hud || ''), `flatReason "${S && S.flatReason}", hud "${r.hud}"`);
      t('no page error', !errs(r).length, errs(r).slice(0, 2).join(' | ') || 'none');
    },
  });

  return [
    main('pc-pe', 'PlayCanvas legacy post effects (camera.postEffects: bloom -> vignette), WebGL2: the chain per eye (glow in both eyes, a vignette per eye)', '', 'webgl2', '', { samples: 1 }),
    main('pc-pe-aa', 'the same on an MSAA device (the queue\'s input target is multisampled)', '', 'webgl2', '&aa=1', { samples: 4 }),
    main('pc-pe-webgpu', 'the same on a WebGPU device (the WGSL shaders of the effects)', '', 'webgpu'),
    main('pc-pe-webgpu-aa', 'the same on a WebGPU device with MSAA', '', 'webgpu', '&aa=1', { samples: 4 }),
    main('pc-pe@2.20', '[PlayCanvas 2.20] legacy post effects per eye, WebGL2 (the oldest engine with Camera.xrViews)', '/pc-2.20', 'webgl2'),
    main('pc-pe@2.24', '[PlayCanvas 2.24] legacy post effects per eye, WebGL2', '/pc-2.24', 'webgl2'),
    main('pc-pe-aa@2.24', '[PlayCanvas 2.24] legacy post effects per eye, WebGL2, MSAA', '/pc-2.24', 'webgl2', '&aa=1', { samples: 4 }),
    main('pc-pe-webgpu@2.24', '[PlayCanvas 2.24] legacy post effects per eye, WebGPU', '/pc-2.24', 'webgpu'),
    {
      // What one chain over the pair looks like (TEST ONLY pcPostEffects: 'unsplit'): the scene passes
      // draw both views into the queue's target, so a pair comes out, but the vignette is the pair's.
      id: 'pc-pe-unsplit-ctl', name: 'control: legacy post effects left as ONE chain over the pair: a pair comes out, but one vignette spans both eyes',
      url: url('', 'gpu=webgl2'), shim: NEW, cfg: { pcPostEffects: 'unsplit' },
      async run(page) {
        await page.waitForFunction(settled(90, 'window.__frozen'), { timeout: 60000, polling: 200 });
        const g = await grab(page);
        return { R: await page.evaluate(active), g, pixels: { png: g.png } };
      },
      check(r, t) {
        if (r.error) { t('ran', false, r.error); return; }
        const { R, g } = r;
        t('converted, the chain not split (postEffects null)', !!R && R.postEffects === null, R ? `postEffects ${JSON.stringify(R.postEffects)}` : 'not active');
        const v = [0, 1].map((e) => vignetteProfile(g.px, g.w, g.h, e));
        t('the vignette is the PAIR\'s: each eye\'s seam side is brighter than its outer edge by > 30', v[0].r - v[0].l > 30 && v[1].l - v[1].r > 30,
          v.map((x, e) => `eye ${e}: ${x.l.toFixed(1)} / ${x.m.toFixed(1)} / ${x.r.toFixed(1)}`).join('; '));
      },
    },
    flat('pc-pe-depth', 'a legacy post effect that reads the scene depth (needsDepthBuffer, as SSAO / bokeh): stays 2D with the reason', 'gpu=webgl2&depth=1', /post effect that reads the scene depth/),
    flat('pc-pe-rect', 'legacy post effects on a camera with a viewport rect: stays 2D with the reason', 'gpu=webgl2&rect=1', /post effects on a camera with a viewport rect/),
    flat('pc-pe-off-ctl', 'control (pcPostEffects false, v0.7.8\'s behaviour): legacy post effects keep the page 2D', 'gpu=webgl2', /post effects on the camera/, { pcPostEffects: false }),
    {
      // Ctrl+Alt+3 off and on. (Not the generic killAfter driver: its out-cover check compares one flat
      // eye with the mono frame, and on this scene the fake's 0.1 skew alone puts that over its bound.)
      id: 'pc-pe-kill', name: 'legacy post effects: Ctrl+Alt+3 off (the page\'s own chain again, one mono picture, nothing of ours on the camera) and on again (the chain per eye again)',
      url: url('', 'gpu=webgl2'), shim: NEW,
      async run(page, h) {
        const key = async () => { await page.keyboard.down('Control'); await page.keyboard.down('Alt'); await page.keyboard.press('Digit3'); await page.keyboard.up('Alt'); await page.keyboard.up('Control'); };
        await page.waitForFunction(settled(90, 'window.__frozen'), { timeout: 60000, polling: 200 });
        const R = await page.evaluate(active);
        await key();
        await h.sleep(1200);
        const off = await page.evaluate(() => {
          const s = window.__dxrAuto3D.state(), r = s.renderers[0], c = window.__camera, q = c.postEffects;
          return { enabled: s.enabled, active: r.active, releasing: r.releasing, pe: r.postEffects, camera: r.camera, hook: typeof c.onPostprocessing, queue: q.enabled,
            rt: c.renderTarget ? [c.renderTarget.width, c.renderTarget.height] : null, isQueueTarget: c.renderTarget === q.effects[0].inputTarget, xr: c.camera.xrViews ? c.camera.xrViews.length : 0 };
        });
        const gOff = await grab(page);
        await key();
        await page.waitForFunction("(() => { const s = window.__dxrAuto3D.state(); const r = s.renderers.find((x) => x.active); return !!(r && r.postEffects && r.postEffects.frames > 30 && r.rampK === 1 && !r.ramping); })()", { timeout: 20000, polling: 200 });
        const on = await page.evaluate(active);
        const gOn = await grab(page);
        return { R, off, gOff, on, gOn, pixels: { png: gOn.png } };
      },
      check(r, t, h) {
        if (r.error) { t('ran', false, r.error); return; }
        const { R, off, gOff, on, gOn } = r;
        t('the chain ran per eye while converted', !!R && !!R.postEffects && R.postEffects.frames > 10 && R.postEffects.mono === 0, JSON.stringify(R && R.postEffects));
        t('Ctrl+Alt+3: back to 2D, xrViews released, nothing of ours in state()', !off.enabled && !off.active && !off.releasing && off.pe === null && off.camera === null && off.xr === 0,
          `enabled ${off.enabled}, active ${off.active}, releasing ${off.releasing}, postEffects ${JSON.stringify(off.pe)}, xrViews ${off.xr}`);
        t('the page\'s queue is as it was: enabled, the camera on its input target at the MONO size, a post-processing hook set', off.queue && off.isQueueTarget && off.hook === 'function' && !!off.rt && off.rt[0] === gOff.w && off.rt[1] === gOff.h && gOff.w === R.page.w,
          `queue enabled ${off.queue}, camera.renderTarget ${off.rt && off.rt.join('x')} (the queue's ${off.isQueueTarget}), canvas ${gOff.w}x${gOff.h}, page ${R.page.w}x${R.page.h}`);
        const sh = h.bestShift(gOff.px, gOff.w, gOff.h, gOff.w / 2);
        const lum = (x, y) => h.lum(gOff.px, (Math.round(y * gOff.h) * gOff.w + Math.round(x * gOff.w)) * 4);
        t('2D: one mono picture through the page\'s own chain (no pair; ONE vignette over the canvas: edges dark, centre top bright)', sh.e > 2 && lum(0.5, 0.2) - Math.max(lum(0.02, 0.2), lum(0.98, 0.2)) > 25 && Math.abs(lum(0.02, 0.2) - lum(0.98, 0.2)) < 6,
          `best half-to-half residual ${sh.e.toFixed(2)} (a pair matches at ~0); row at 20 %: ${lum(0.02, 0.2).toFixed(1)} / ${lum(0.5, 0.2).toFixed(1)} / ${lum(0.98, 0.2).toFixed(1)}`);
        t('Ctrl+Alt+3 again: converted again, the chain per eye again', !!on && !!on.postEffects && on.postEffects.hooked && on.postEffects.mono === 0, JSON.stringify(on && on.postEffects));
        const v = [0, 1].map((e) => vignetteProfile(gOn.px, gOn.w, gOn.h, e));
        t('... a vignette per eye', v.every((x) => Math.abs(x.l - x.r) < 6 && x.m - Math.max(x.l, x.r) > 25), v.map((x, e) => `eye ${e}: ${x.l.toFixed(1)} / ${x.m.toFixed(1)} / ${x.r.toFixed(1)}`).join('; '));
        t('no page error', !errs(r).length, errs(r).slice(0, 2).join(' | ') || 'none');
      },
    },
    {
      // The page removes its effects while converted (the queue disables itself and gives the camera
      // its canvas target back), then adds them again (a new input target, a new hook).
      id: 'pc-pe-toggle', name: 'the page removes its post effects, then adds them again, while converted: plain eyes, then the chain per eye again, no stand-down',
      url: url('', 'gpu=webgl2'), shim: NEW,
      async run(page, h) {
        await page.waitForFunction(settled(90, 'window.__frozen'), { timeout: 60000, polling: 200 });
        const before = await page.evaluate(active);
        await page.evaluate(() => { const q = window.__camera.postEffects; q.removeEffect(window.__fx.vignette); q.removeEffect(window.__fx.bloom); });
        await h.sleep(600);
        const off = await page.evaluate(active);
        const gOff = await grab(page);
        const rtOff = await page.evaluate(() => ({ rt: !!window.__camera.renderTarget, hook: typeof window.__camera.onPostprocessing }));
        await page.evaluate(() => { const q = window.__camera.postEffects; q.addEffect(window.__fx.bloom); q.addEffect(window.__fx.vignette); });
        await h.sleep(600);
        const on = await page.evaluate(active);
        const gOn = await grab(page);
        return { before, off, on, gOff, gOn, rtOff, pixels: { png: gOn.png } };
      },
      check(r, t) {
        if (r.error) { t('ran', false, r.error); return; }
        const { before, off, on, gOff, gOn, rtOff } = r;
        t('the chain per eye while the effects are on', !!before && !!before.postEffects && before.postEffects.frames > 10, JSON.stringify(before && before.postEffects));
        t('effects removed: still converted, no chain, the camera draws to the canvas again and its post-processing hook is gone (not ours left behind)',
          !!off && off.postEffects === null && !rtOff.rt && rtOff.hook !== 'function', `active ${!!off}, postEffects ${JSON.stringify(off && off.postEffects)}, camera.renderTarget ${rtOff.rt}, onPostprocessing ${rtOff.hook}`);
        const want = Math.round(0.1 * gOff.w / 2);
        const so = [0, 1].map((e) => sphere(gOff.px, gOff.w, gOff.h, e, 230));
        t('effects removed: both eyes drawn by the plain xrViews path', so[0] && so[1] && Math.abs(so[1].cx - so[0].cx - want) <= 2, so.map((x, e) => (x ? `eye ${e} sphere at ${x.cx.toFixed(1)}` : `eye ${e}: none`)).join('; '));
        t('effects added again: the chain per eye again, the same canvas session', !!on && !!on.postEffects && on.postEffects.frames > 5 && on.postEffects.mono === 0 && on.stats.twoView > before.stats.twoView,
          on ? `postEffects ${JSON.stringify(on.postEffects)}, twoView ${before.stats.twoView} -> ${on.stats.twoView}` : 'not active');
        const s = [0, 1].map((e) => sphere(gOn.px, gOn.w, gOn.h, e));
        t('effects added again: both eyes, parallax', s[0] && s[1] && Math.abs(s[1].cx - s[0].cx - want) <= 2, s.map((x, e) => (x ? `eye ${e} sphere at ${x.cx.toFixed(1)}` : `eye ${e}: none`)).join('; '));
        const v = [0, 1].map((e) => vignetteProfile(gOn.px, gOn.w, gOn.h, e));
        t('effects added again: a vignette per eye', v.every((x) => Math.abs(x.l - x.r) < 6 && x.m - Math.max(x.l, x.r) > 25), v.map((x, e) => `eye ${e}: ${x.l.toFixed(1)} / ${x.m.toFixed(1)} / ${x.r.toFixed(1)}`).join('; '));
        const bad = /pageerror|\[error\]|back to 2D: (?!pagehide)/; // pagehide: the harness closing the page
        t('no page error, no stand-down', !errs(r, bad).length, errs(r, bad).slice(0, 2).join(' | ') || 'none');
      },
    },
  ];
}

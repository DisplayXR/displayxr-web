// The GL-level adapter (gl-adapter.js, v0.9.0): a canvas no engine adapter claims, converted by what its
// WebGL stream does. The page (pages/gl-multipass.html) is raw WebGL2 shaped like a model viewer's renderer:
// a shadow pass with a square perspective light (a projecting matrix in the vertex shader that is NOT the
// camera), the scene into a screen-sized framebuffer with the camera's P as its own uniform, a half-size
// bloom pass sampling it, a composite to the screen, a HUD quad. No network.
//
// The generic 'convert' checks apply (run.mjs): converted, 2:1 store, right half = left half shifted by
// the fake's 0.1 skew x eye width (every pixel moves by the skew whatever its depth, so a pass drawn once,
// or a right eye that sampled the left eye's chain, would break it), HUD counters, the rig, the convergence
// (?spin=1: the orbit pivot read from the camera's own motion = the camera's distance; at rest: the
// estimator over the draws' origins, which the page computes the same way).
export default function cases({ P, NEW }) {
  const page = P + 'gl-multipass.html';
  const base = { shim: NEW, expect: 'convert', fovDeg: (0.8 * 180) / Math.PI, url: page + '?spin=1', ready: 'window.__spun' };
  const glOf = (r) => { const R = r.state && r.state.renderers.find((x) => x.engine === 'WebGL'); return R && R.gl; };
  const passes = (r, t) => {
    const G = glOf(r);
    t('the GL-level adapter drives it (engine WebGL)', !!G, G ? `frames ${G.frames}` : 'no WebGL renderer');
    if (!G) return null;
    // per frame: 6 shadow draws once; 6 scene draws + 1 bloom twice (twins); composite + HUD once per half
    t('shadow pass drawn once, the camera passes twice', G.last.single === 6 && G.last.doubled === 9, JSON.stringify(G.last));
    t('the camera P was recognised (not the square light VP)', G.P && Math.abs(G.P[5] / G.P[0] - 16 / 9) < 0.02, JSON.stringify(G.P));
    t('twins made: scene colour + depth + framebuffer, bloom colour + framebuffer', G.twins === 5, `twins ${G.twins}`);
    return G;
  };
  const grabCanvas = () => new Promise((res) => requestAnimationFrame(() => setTimeout(() => {
    const src = document.querySelector('canvas:not([data-dxr-auto3d-cover])');
    const w = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width').get.call(src), h = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height').get.call(src);
    const c2 = document.createElement('canvas'); c2.width = w; c2.height = h; const g = c2.getContext('2d', { willReadFrequently: true }); g.drawImage(src, 0, 0);
    const d = g.getImageData(0, 0, w, h).data; let s = ''; for (let i = 0; i < d.length; i += 32768) s += String.fromCharCode.apply(null, d.subarray(i, i + 32768));
    res({ w, h, b64: btoa(s) });
  }, 0)));
  return [
    { ...base, id: 'gl-multipass', name: 'raw WebGL2 multi-pass page: the GL-level adapter converts it (shadow once, scene + bloom per eye, composite per half); go-live committed', commits: true,
      alsoCheck: (r, t) => passes(r, t) },
    { ...base, id: 'gl-21', name: 'raw WebGL2 multi-pass page on the product 2:1 store (eyeScale 1): each eye the element\'s full device width', cfg: { eyeScale: 1 },
      alsoCheck(r, t, H, R) { passes(r, t); t('2:1 store: eye = element device width', R && R.eye[0] === 1280 && R.real[0] === 2560, R && `store ${R.real}, eye ${R.eye}`); } },
    { ...base, id: 'gl-static', name: 'raw WebGL2 multi-pass page, camera at rest: convergence from the estimator over the draws\' origins', url: page, ready: 'true' },
    { ...base, id: 'gl-pdb0', name: 'raw WebGL2 multi-pass page with preserveDrawingBuffer false (read in the drawing task)', url: page + '?spin=1&pdb=0',
      alsoCheck: (r, t) => passes(r, t) },
    { ...base, id: 'gl-idle-kill', name: 'raw WebGL2 page that stops drawing: the session replays the copy; Ctrl+Alt+3 off (mono + out-cover) and on again on the frozen page',
      url: page + '?idle=1', ready: 'window.__frozen', killAfter: true, commits: true, minFrames: 400,
      alsoCheck(r, t, H, R) { t('the session replays the copy while the page draws nothing', R && R.stats.replays >= 10, R && `replays ${R.stats.replays}`); } },
    { ...base, id: 'gl-idle-aa', name: 'raw WebGL2 page, antialias true, that stops drawing: the replay goes through the textured-triangle path', url: page + '?idle=1&aa=1', ready: 'window.__frozen', minFrames: 400,
      alsoCheck(r, t, H, R) { const G = glOf(r); t('multisampled screen seen; the session replays', G && G.msaa === true && R.stats.replays > 20, `msaa ${G && G.msaa}, replays ${R && R.stats.replays}`); } },
    { id: 'gl-ortho', name: 'raw WebGL2 page with an orthographic camera: stays 2D, the reason named', shim: NEW, url: page + '?ortho=1', expect: 'flat',
      check(r, t) {
        const R = r.state && r.state.renderers.find((x) => x.engine === 'WebGL');
        t('watched by the GL-level adapter, not converted', R && !R.active, R ? `active ${R.active}` : 'no WebGL renderer');
        t('the console names why', r.log.some((l) => /no perspective camera draw seen at the WebGL level/.test(l)), '');
      } },
    { id: 'gl-three-untouched', name: 'a three.js page: the three.js adapter converts it; the GL-level adapter never takes its canvas', shim: NEW, url: P + 'three-orbit.html', expect: 'flat',
      check(r, t) {
        const S = r.state;
        t('three.js converts it', S && S.renderers.some((x) => x.engine === 'three.js' && x.active), S && S.renderers.map((x) => `${x.engine}:${x.active}`).join(','));
        t('no WebGL (GL-level) renderer in state()', S && !S.renderers.some((x) => x.engine === 'WebGL'), '');
        t('the GL-level adapter was never handed the canvas', !r.log.some((l) => /handed to the GL-level adapter/.test(l)), '');
      } },
    { id: 'gl-resize', name: 'raw WebGL2 multi-pass page resized while live: the store follows, still a correct pair', shim: NEW, url: page + '?spin=1',
      async run(pg) {
        await pg.waitForFunction(() => { const s = window.__dxrAuto3D && window.__dxrAuto3D.state(); const r = s && s.renderers.find((x) => x.active); return !!(r && r.stats.twoView > 60 && window.__spun); }, { timeout: 60000, polling: 200 });
        await pg.setViewport({ width: 960, height: 540, deviceScaleFactor: 1 });
        await new Promise((res) => setTimeout(res, 2500));
        const st = await pg.evaluate(() => window.__dxrAuto3D.state().renderers.find((x) => x.engine === 'WebGL'));
        const px = await pg.evaluate(grabCanvas);
        return { st, px: { w: px.w, h: px.h, buf: Buffer.from(px.b64, 'base64') } };
      },
      check(r, t, H) {
        const S = r.st;
        t('still live after the resize, store = the new element size (eye 480 x 540)', S && S.active && S.eye[0] === 480 && S.eye[1] === 540 && S.real[0] === 960, S ? `active ${S.active}, store ${S.real}, eye ${S.eye}, page ${JSON.stringify(S.page)}` : r.error);
        if (!r.px) return;
        const sh = H.bestShift(r.px.buf, r.px.w, r.px.h, r.px.w / 2, 48);
        t('right half = left half shifted 48 px (0.1 x eye)', Math.abs(sh.s - 48) <= 1, `best shift ${sh.s} (residual ${sh.e.toFixed(2)})`);
      } },
  ];
}

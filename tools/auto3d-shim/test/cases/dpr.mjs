// P0.2 fix 4: the eye is sized from the element's DEVICE pixels, whatever store the page keeps. Spark's
// hello-world renders at pixel ratio 1 on a 2.5x panel (a 1038-px store on a 1038-px CSS canvas), so a
// store-sized eye was 519 px. Emulated here: a three.js page at pixel ratio 1 on a DPR 2 viewport.
export default function cases({ P, NEW }) {
  const dpr2 = (page) => page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 2 });
  return [
    {
      id: 'a-dpr2', name: 'three.js at pixel ratio 1 on a DPR 2 viewport: SBS store = the element\'s device size (eye 600x800: half the 1200 device width, the full 800 height); the page still reads its mono store; restore() puts it back',
      url: P + 'three-keyframes.html?pr=1&w=600&h=400', shim: NEW, cfg: { convTarget: false }, expect: 'convert', fovDeg: 40, ready: 'window.__frozen',
      killAfter: true, commits: true, before: dpr2,
      alsoCheck(r, t, h, R) {
        t('600x400 CSS at DPR 2: eye 600x800, SBS 1200x800 (the device size)', R.eye[0] === 600 && R.eye[1] === 800 && R.real[0] === 1200 && R.real[1] === 800,
          `eye ${R.eye.join('x')}, store ${R.real.join('x')}, CSS ${R.css.join('x')}`);
        t("the page's own store stays 600x400 at pixel ratio 1 (getSize / getPixelRatio / canvas.width)", R.page.w === 600 && R.page.h === 400 && R.page.pr === 1 && R.page.canvasWidthSeenByPage === 600,
          JSON.stringify(R.page));
        const a = r.after;
        t("after the turn-off the store is the page's own again (600x400)", a && a.w === 600 && a.h === 400, a ? `${a.w}x${a.h}` : 'n/a');
      },
    },
    // v0.7.11 (#319): the caps scale BOTH axes by one factor, so the eye's store pixels keep their
    // shape. A maximised window on an 8K panel at 300 % (2560x1305 CSS) wanted eye 3840x3915 and got
    // 1536x3915 (the width capped, the height not): 2.5x the pixels the width allows, store pixels 2.5x
    // taller than wide. Emulated at DPR 3 on a 1280x720 viewport: eye 1920x2160 wanted, the 3072 cap
    // is 0.8 of that, so eye 1536x1728 (not 1536x2160).
    ...['three-keyframes.html', 'pc-mesh.html'].map((page) => ({
      id: `a-cap-square-${page.startsWith('pc') ? 'pc' : 'three'}`,
      name: `${page.startsWith('pc') ? 'PlayCanvas' : 'three.js'} at DPR 3: the width cap (3072) scales the height by the same factor (eye 1536x1728, not 1536x2160)`,
      url: P + page, shim: NEW, cfg: { convTarget: false }, expect: 'convert', fovDeg: 40, ready: 'window.__frozen',
      before: (page) => page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 3 }),
      alsoCheck(r, t, h, R) {
        t('eye 1536x1728, SBS 3072x1728 (0.8 x the 1920x2160 device-pixel eye on both axes)', R.eye[0] === 1536 && R.eye[1] === 1728 && R.real[0] === 3072 && R.real[1] === 1728,
          `eye ${R.eye.join('x')}, store ${R.real.join('x')}, CSS ${R.css.join('x')}`);
      },
    })),
    // The area cap (maxSbsArea, Chromium's 5760^2 drawing-buffer cap by default) by the same one factor:
    // here 240000 px on a 1200x800 store, i.e. 0.5 per axis.
    {
      id: 'a-cap-area', name: 'three.js, area cap (maxSbsArea 240000 on a 1200x800 SBS store): one factor 0.5 for both axes -> eye 300x400',
      url: P + 'three-keyframes.html?pr=1&w=600&h=400', shim: NEW, cfg: { convTarget: false, maxSbsArea: 240000 }, expect: 'convert', fovDeg: 40, ready: 'window.__frozen', before: dpr2,
      alsoCheck(r, t, h, R) {
        t('eye 300x400, SBS 600x400', R.eye[0] === 300 && R.eye[1] === 400 && R.real[0] === 600 && R.real[1] === 400, `eye ${R.eye.join('x')}, store ${R.real.join('x')}`);
      },
    },
  ];
}

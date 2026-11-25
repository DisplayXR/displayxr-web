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
  ];
}

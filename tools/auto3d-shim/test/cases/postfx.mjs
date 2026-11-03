// Post-processing on the three.js adapter: the scene drawn into a render target, then full-screen
// passes, then the screen. Asserted through the same 'convert' checks as case 'a': the halves must
// differ by the fake eyes' shift, which fails if the right eye samples the left eye's chain.
//
// The page camera's view window (setViewOffset, visual-learning.app/sandworm): the generic checks
// pass whether or not the view reaches the eyes (both halves are equally wrong without it), so the
// view cases also measure WHERE the marker lands. The fake views skew x only, so the marker's
// height in the left eye must be the page's own projection of it (window.__expectNdcY).
const MARKER_TOL = 0.02; // NDC (7 px of 720); without the view: 0.24 (shift), 0.33 (crop)

// The magenta marker's centroid in the left eye, as NDC y.
function markerNdcY(px, w, h, eyeW) {
  let sy = 0, n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < eyeW; x++) {
      const i = (y * w + x) * 4, r = px[i], g = px[i + 1], b = px[i + 2];
      if (r > 150 && b > 150 && g < 0.3 * Math.min(r, b)) { sy += y; n++; }
    }
  }
  return n >= 50 ? { y: 1 - (2 * (sy / n + 0.5)) / h, n } : { y: NaN, n };
}
function framed(r, t, h, R) {
  const exp = r.probe, m = markerNdcY(r.pixels.px, r.pixels.w, r.pixels.h, R.eye[0]);
  t(`the page's view window reaches the eyes: marker at its own projection (±${MARKER_TOL} NDC)`, typeof exp === 'number' && Math.abs(m.y - exp) <= MARKER_TOL,
    `left eye ${m.y.toFixed(3)} (${m.n} px), page ${typeof exp === 'number' ? exp.toFixed(3) : exp}`);
}

// The chain's mirror probe (probeMirror), as state() reports it.
const mirrorIs = (want) => (r, t, h, R) => t(`mirror probe: the chain is ${want ? '' : 'NOT '}taken as mirrored`, R.chainMirror === want, `chainMirror ${R.chainMirror}, r [as drawn, mirrored] ${JSON.stringify(R.mirrorCorr)}`);
// Real parallax (the fake's eyeX 0.1, eyes 0.2 apart): skew 64 px minus the eyes' parallax at the
// subject (2·f·eyeX / z = 2·989·0.1 / 8 ≈ 25 px) = 39 px with the eyes in order; with them swapped
// (pseudoscopic) it would be 64 + 25.
const EYES_SHIFT = 39 / 640;
// A view that moves along one axis (#231): framed as the page frames it, and never taken for jitter.
const oneAxis = {
  timeoutMs: 20000,
  alsoCheck(r, t, h, R) {
    framed(r, t, h, R);
    const why = r.log.find((l) => /jitters camera\.setViewOffset/.test(l));
    t('never taken for jitter (no "stays 2D: the scene pass jitters …" line), live at the end', !why && R && R.flatReason == null, why || `flatReason ${R && R.flatReason}`);
  },
};

export default function cases({ P, NEW }) {
  const view = (q, extra) => ({
    url: P + 'three-postfx.html?' + q, shim: NEW, cfg: { convTarget: false }, expect: 'convert', fovDeg: 40, ready: 'window.__frozen',
    probe: () => window.__expectNdcY, alsoCheck: framed, ...extra,
  });
  const chain = (id, name, q, extra) => ({ id, name, url: P + 'three-postfx.html' + q, shim: NEW, cfg: { convTarget: false }, expect: 'convert', fovDeg: 40, ready: 'window.__frozen', ...extra });
  return [
    chain('e-postfx', 'three.js post chain (scene target + two-pass blur on ONE material + composite + HUD)', '', { alsoCheck: mirrorIs(false) }),
    chain('e-postfx-eyes', 'post chain, eyes 0.2 apart (real parallax): the eye order of the chain path = the direct path\'s', '', { fake: { eyeX: 0.1 }, pairShift: EYES_SHIFT }),
    chain('e-postfx-mirror', 'post chain whose composite flips the picture left-right (visual-learning.app/sandworm): found, each eye drawn mirrored, the pair the right way round', '?mirror=1', {
      alsoCheck(r, t, h, R) {
        mirrorIs(true)(r, t, h, R);
        t('console: "the post chain … mirrors its picture left-right"', r.log.some((l) => /mirrors its picture left-right/.test(l)), '');
      },
    }),
    chain('e-postfx-mirror-overlay', 'mirrored chain seeded three times a frame, the last seed blank (sandworm on the panel): the probe and the estimator use the main seed', '?mirror=1&overlay=1', {
      alsoCheck(r, t, h, R) {
        mirrorIs(true)(r, t, h, R);
        t('decided on the first ask (not by the 3 s fallback)', R.mirrorWhy === 'decided' && R.mirrorAsks === 1, `mirrorWhy "${R.mirrorWhy}", asks ${R.mirrorAsks}`);
      },
    }),
    chain('e-postfx-mirror-ctl', 'CONTROL: the same page with the mirror probe off (chainMirror: false): the pair comes out pseudoscopic (-64 px)', '?mirror=1', { cfg: { convTarget: false, chainMirror: false }, pairShift: -0.1, alsoCheck: mirrorIs(false) }),
    chain('e-postfx-mirror-eyes', 'mirrored chain, eyes 0.2 apart: the same 39 px as unmirrored (eye order AND parallax direction kept)', '?mirror=1', { fake: { eyeX: 0.1 }, pairShift: EYES_SHIFT, alsoCheck: mirrorIs(true) }),
    { id: 'e-postfx-view0', name: 'post chain, the scene camera keeps an identity setViewOffset (visual-learning.app/sandworm at rest)', ...view('view=identity') },
    { id: 'e-postfx-shift', name: 'post chain, the scene camera keeps a lens shift (setViewOffset, 12 % down): framed as the page frames it', ...view('view=shift') },
    { id: 'e-postfx-crop', name: 'post chain, the scene camera keeps a 2x off-centre crop (setViewOffset): framed as the page frames it, disparity x2', ...view('view=crop', { pairShift: 0.2 }) },
    { id: 'e-direct-shift', name: 'no chain: a lens-shifted camera straight to the screen converts in stereo (was flat), framed as the page frames it', ...view('view=shift&chain=0') },
    {
      id: 'e-postfx-jitter', name: 'post chain whose scene pass sets a sub-pixel setViewOffset for that draw only (SSAA / TAA): stays 2D, reported flat with the reason',
      url: P + 'three-postfx.html?view=jitter', shim: NEW, cfg: { convTarget: false }, expect: 'flat', ready: 'window.__frozen',
      check(r, t) {
        const S = r.state && r.state.renderers[0];
        t('no session requested, nothing converted', r.fake.sessions === 0 && S && !S.active && !S.pending, `sessions ${r.fake.sessions}, active ${S && S.active}`);
        t('flat with the jitter reason (state, HUD)', S && /jitters camera\.setViewOffset/.test(S.flatReason || '') && /jitters camera\.setViewOffset/.test(r.hud || ''), `flatReason "${S && S.flatReason}", hud "${r.hud}"`);
        t('console: "stays 2D: the scene pass jitters …"', r.log.some((l) => /stays 2D: the scene pass jitters camera\.setViewOffset/.test(l)), '');
      },
    },
    // #226: a jitter left set across frames (a TAA that never clears its offset).
    {
      id: 'e-postfx-taa', name: 'post chain whose scene camera keeps a sub-pixel jitter set across frames (a TAA that never clears it): stays 2D, reported flat with the reason',
      url: P + 'three-postfx.html?view=taa', shim: NEW, cfg: { convTarget: false }, expect: 'flat', ready: 'window.__frozen',
      check(r, t) {
        const S = r.state && r.state.renderers[0];
        t('no session requested, nothing converted', r.fake.sessions === 0 && S && !S.active && !S.pending, `sessions ${r.fake.sessions}, active ${S && S.active}`);
        t('flat with the jitter reason (state, HUD)', S && /jitters camera\.setViewOffset/.test(S.flatReason || '') && /jitters camera\.setViewOffset/.test(r.hud || ''), `flatReason "${S && S.flatReason}", hud "${r.hud}"`);
      },
    },
    { id: 'e-postfx-pan', name: 'post chain whose lens shift drifts 0.3 px a frame, one way: framing, not jitter (converts, framed as the page frames it)', ...view('view=pan') },
    // #231: sub-pixel framing along ONE axis that turns back often. v0.6.4 took each for jitter within
    // 8 frames (a timeout here: it never stays live).
    { id: 'e-postfx-bob', name: 'post chain whose lens shift bobs 0.5 px on y (period 8 frames): framing, not jitter (converts and stays live)', ...view('view=bob', oneAxis) },
    { id: 'e-postfx-spring', name: 'post chain whose lens shift ends in an underdamped spring\'s tail on x (0.9 px decaying, period 7 frames): framing, not jitter', ...view('view=spring', oneAxis) },
    { id: 'e-postfx-parallax', name: 'post chain with a lerped mouse parallax on x (the mouse wobbles by whole px): framing, not jitter', ...view('view=parallax', oneAxis) },
    {
      id: 'e-postfx-taa-late', name: 'post chain with a steady view, then a jitter left on from frame 31: converts, then stands down with the reason',
      url: P + 'three-postfx.html?view=taa-late', shim: NEW, cfg: { convTarget: false }, expect: 'flat', ready: 'window.__frozen',
      check(r, t) {
        const S = r.state && r.state.renderers[0];
        t('converted first (one session, one layer)', r.fake.sessions === 1 && r.fake.layers === 1, `sessions ${r.fake.sessions}, layers ${r.fake.layers}`);
        t('then back to 2D: "back to 2D: the scene pass jitters …"', r.log.some((l) => /back to 2D: the scene pass jitters camera\.setViewOffset/.test(l)), r.log.filter((l) => /back to 2D/.test(l)).join(' | ') || 'no back-to-2D line');
        t('ends flat with the jitter reason, not live', S && !S.active && /jitters camera\.setViewOffset/.test(S.flatReason || ''), `active ${S && S.active}, flatReason "${S && S.flatReason}"`);
      },
    },
    {
      id: 'e-postfx-taa-half', name: 'post chain on a half-size scene target whose TAA jitter (in that target\'s px, ±1 canvas px) is left set: stays 2D, reported flat with the reason',
      url: P + 'three-postfx.html?view=taa&rtScale=0.5', shim: NEW, cfg: { convTarget: false }, expect: 'flat', ready: 'window.__frozen',
      check(r, t) {
        const S = r.state && r.state.renderers[0];
        t('no session requested, nothing converted', r.fake.sessions === 0 && S && !S.active && !S.pending, `sessions ${r.fake.sessions}, active ${S && S.active}`);
        t('flat with the jitter reason', S && /jitters camera\.setViewOffset/.test(S.flatReason || ''), `flatReason "${S && S.flatReason}"`);
      },
    },
    {
      id: 'e-postfx-taa-short', name: 'post chain whose TAA holds sample 1 while "moving", then takes 5 more samples left set and stops drawing the scene: converts, then stands down with the reason',
      url: P + 'three-postfx.html?view=taa-short', shim: NEW, cfg: { convTarget: false }, expect: 'flat', ready: 'window.__frozen',
      check(r, t) {
        const S = r.state && r.state.renderers[0];
        t('then back to 2D: "back to 2D: the scene pass jitters …"', r.log.some((l) => /back to 2D: the scene pass jitters camera\.setViewOffset/.test(l)), r.log.filter((l) => /back to 2D/.test(l)).join(' | ') || 'no back-to-2D line');
        t('ends flat with the jitter reason, not live', S && !S.active && /jitters camera\.setViewOffset/.test(S.flatReason || ''), `active ${S && S.active}, flatReason "${S && S.flatReason}"`);
      },
    },
    {
      id: 'e-postfx-miss', name: 'post chain whose scene target is a quarter of the canvas: stays 2D, and the console says why the seed was not taken',
      url: P + 'three-postfx.html?rtScale=0.25', shim: NEW, cfg: { convTarget: false }, expect: 'idle2d', ready: 'window.__frozen',
      check(r, t) {
        const S = r.state && r.state.renderers[0];
        t('nothing converted', r.fake.sessions === 0 && S && !S.active, `sessions ${r.fake.sessions}`);
        const line = r.log.find((l) => /not converting/.test(l)) || '';
        t('console names the near-miss seed: target 320x180 is under half the canvas', /not as a post chain's input: target 320x180 is under half the canvas's 1280x720 px/.test(line), line || 'no line');
      },
    },
  ];
}

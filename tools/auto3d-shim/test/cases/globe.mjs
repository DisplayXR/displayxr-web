// The globe part (v0.8.2, globe-adapter.js on the generic WebGL tap gl-tap.js): a raw-WebGL renderer
// that draws a TILED WORLD (a globe / 3D map) is recognised by what it draws and converted as a world
// (camera rig, fixed focus on the ground at the centre of the view), with its screen-space labels and
// pins drawn at the glass in both eyes. pages/globe-tiles.html reproduces the renderer's behaviour
// offline (per-tile matrices, two passes, a sky and labels with no matrix, a 2D overlay canvas, render
// on demand), so none of this depends on a third-party site.
//
// What is read: window.__dxrGlobe (dev only) grabs the side-by-side store in the page's drawing task;
// the halves are block-matched here (horizontal disparity by band, vertical disparity, the inner-edge
// seam, the labels' magenta pixels).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const OUT = new URL('../out/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const W = 1280, H = 720, EYE = W / 2;

// --- pixel analysis of a side-by-side RGBA buffer (Buffer, w x h) ---
const L = (px, i) => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
function blockDisparity(px, w, h, { B = 16, S = 40, VS = 3, x0 = 0 } = {}) {
  // Every pixel of the block; a block is kept only when its best match is clearly the best (no tie
  // with a shift 3+ px away: periodic or flat content), and dy reports a vertical shift only when it is
  // clearly better than dy = 0 at that horizontal shift.
  const eye = w / 2, out = [], n = B * B;
  const cost = (x, y, d, dy) => { let e = 0; for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) { const a = L(px, ((y + j) * w + x + i) * 4), b = L(px, ((y + j + dy) * w + eye + x + i + d) * 4); e += (a - b) * (a - b); } return e / n; };
  for (let y = VS; y < h - B - VS; y += B) {
    for (let x = Math.max(S, x0); x < eye - B - S; x += B) {
      let m = 0, m2 = 0;
      for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) { const l = L(px, ((y + j) * w + x + i) * 4); m += l; m2 += l * l; }
      m /= n; const v = m2 / n - m * m;
      if (v < 150) continue; // untextured
      const row = [];
      for (let d = -S; d <= S; d++) row.push(cost(x, y, d, 0));
      let bi = 0; for (let i = 1; i < row.length; i++) if (row[i] < row[bi]) bi = i;
      let second = Infinity; for (let i = 0; i < row.length; i++) if (Math.abs(i - bi) >= 3) second = Math.min(second, row[i]);
      if (!(row[bi] < 0.25 * v) || !(row[bi] < 0.6 * second)) continue;
      const d = bi - S;
      let bdy = 0, bc = row[bi];
      for (let dy = -VS; dy <= VS; dy++) { if (!dy) continue; const c = cost(x, y, d, dy); if (c < 0.7 * bc) { bc = c; bdy = dy; } }
      out.push({ x, y, d, dy: bdy });
    }
  }
  return out;
}
const median = (a) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; };
// The centroid x (eye px) of the pixels of one colour, per half.
function colourCentroids(px, w, h, rgb) {
  const eye = w / 2, acc = [[0, 0, 0], [0, 0, 0]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (Math.abs(px[i] - rgb[0]) < 40 && Math.abs(px[i + 1] - rgb[1]) < 40 && Math.abs(px[i + 2] - rgb[2]) < 40) { const e = x < eye ? 0 : 1; acc[e][0] += x - e * eye; acc[e][1] += y; acc[e][2]++; }
  }
  return acc.map(([sx, sy, n]) => ({ n, x: n ? sx / n : NaN, y: n ? sy / n : NaN }));
}
// Uniform columns at the halves' inner edges = an unfilled seam.
function innerEdge(px, w, h) {
  const eye = w / 2, sd = (x) => { let m = 0, m2 = 0; for (let y = 0; y < h; y += 2) { const l = L(px, (y * w + x) * 4); m += l; m2 += l * l; } const n = h / 2; m /= n; return Math.sqrt(Math.max(0, m2 / n - m * m)); };
  const cols = []; for (let x = eye - 6; x < eye + 6; x++) cols.push(sd(x));
  return { min: Math.min(...cols), mean: cols.reduce((a, b) => a + b, 0) / cols.length };
}

async function load(page, base, P, url) {
  await page.goto(base + P + url, { waitUntil: 'load' });
}
const grab = (page) => page.evaluate(() => Promise.race([
  window.__dxrGlobe.grab().then((g) => { const im = new Image(); return new Promise((res) => { im.onload = () => { const c = document.createElement('canvas'); c.width = g.w; c.height = g.h; const x = c.getContext('2d'); x.drawImage(im, 0, 0); const d = x.getImageData(0, 0, g.w, g.h).data; let s = ''; for (let i = 0; i < d.length; i += 32768) s += String.fromCharCode.apply(null, d.subarray(i, i + 32768)); res({ w: g.w, h: g.h, live: g.live, stereo: g.stereo, fit: g.fit, surf: g.surf, b64: btoa(s), png: g.png }); }; im.src = g.png; }); }),
  new Promise((r) => setTimeout(() => r(null), 5000)),
]));
const stateOf = (page) => page.evaluate(() => { const s = window.__dxrAuto3D && window.__dxrAuto3D.state(); return { engines: s && s.engines, renderers: s ? s.renderers.map((r) => ({ engine: r.engine, active: r.active, src: r.convergenceSource, open: r.openLatched, openWhy: r.openWhy, twoView: r.stats && r.stats.twoView, rampK: r.rampK })) : [], rigMode: s && s.rigMode, globe: window.__dxrGlobe ? window.__dxrGlobe.states().map((g) => ({ recognised: g.recognised, q: g.qualifying, fit: g.fit && { relief: g.fit.relief, relres: g.fit.relres } })) : null, fake: { sessions: window.__fakeXR.sessions.length, layers: window.__fakeXR.layers.length } }; });
const live = (page, ms = 20000) => page.waitForFunction(() => { const s = window.__dxrAuto3D && window.__dxrAuto3D.state(); const r = s && s.renderers.find((x) => x.active && x.engine === 'WebGL globe'); return !!(r && r.stats.twoView > 60 && r.rampK === 1); }, { timeout: ms, polling: 200 }).then(() => true, () => false);

export default function cases({ P, NEW }) {
  // runtime model: half-IPD eyes, the panel's 2:1 store pixels (the eye shear the runtime would hand back)
  const fake = { nominal: [0, 0.1, 0.6], eyeX: 0.032, pixelAspect: 2 };
  const cfg = { rig: 'auto', guardFps: 0 };
  return [
    {
      id: 'g-globe-live', name: 'globe page (raw WebGL tiled world): recognised by behaviour, converted as a world; disparity by depth, no vertical disparity, no seam, labels at the glass in both eyes',
      url: P + 'globe-tiles.html', shim: NEW, cfg, fake,
      async run(page, h) {
        const ok = await live(page);
        await page.waitForFunction(() => window.__frozen, { timeout: 15000 }).catch(() => {}); // the tiles' buffers were streamed again by now
        const st = await stateOf(page);
        const g1 = ok ? await grab(page) : null;
        // a scripted zoom out (globe scale) and in (street scale), the page drawing on demand
        await page.evaluate(() => window.__setCam({ dist: 6000 })); await h.sleep(600);
        const gFar = ok ? await grab(page) : null;
        await page.evaluate(() => window.__setCam({ dist: 250, pitch: 0.45 })); await h.sleep(600);
        const gNear = ok ? await grab(page) : null;
        if (process.env.KEEP) { mkdirSync(OUT, { recursive: true }); [g1, gFar, gNear].forEach((g, i) => g && writeFileSync(join(OUT, `g-globe-live-${['tilt', 'far', 'street'][i]}.png`), Buffer.from(g.png.split(',')[1], 'base64'))); }
        return { live: ok, st, shots: [g1, gFar, gNear].map((g) => g && { ...g, px: Buffer.from(g.b64, 'base64'), b64: undefined }) };
      },
      check(r, t) {
        const S = r.st || {}, R = (S.renderers || []).find((x) => x.engine === 'WebGL globe');
        t('recognised and live (engine "WebGL globe")', r.live && !!R && R.active, JSON.stringify(S.renderers) + ' ' + JSON.stringify(S.globe));
        t('a world: open scene latched with the globe reason, camera rig', !!R && R.open && /tiled globe/.test(R.openWhy || '') && S.rigMode === 'camera', `${R && R.openWhy} / ${S.rigMode}`);
        const names = ['tilted', 'zoomed out', 'street level'];
        (r.shots || []).forEach((g, i) => {
          if (!g) { t(`${names[i]}: a frame was grabbed`, false, 'no grab'); return; }
          const D = blockDisparity(g.px, g.w, g.h);
          const top = D.filter((b) => b.y < g.h * 0.3).map((b) => b.d), bot = D.filter((b) => b.y > g.h * 0.75).map((b) => b.d);
          // Vertical: a real vertical disparity is CONSISTENT (the median and the mean move); block-matching
          // ties on smooth texture are ±1 px and symmetric. Two-pixel matches must be rare.
          const dys = D.map((b) => b.dy), dyMean = dys.reduce((p, q) => p + q, 0) / Math.max(1, dys.length), dy2 = dys.filter((v) => Math.abs(v) >= 2).length / Math.max(1, dys.length);
          const all = D.map((b) => b.d);
          const lim = Math.ceil(Math.abs(g.stereo.k[1] - g.stereo.k[0]) * EYE / 2) + 3; // |2k| of NDC in eye px, +3 px slack
          t(`${names[i]}: ${D.length} textured blocks matched`, D.length > 40, String(D.length));
          if (i === 0) {
            t(`${names[i]}: far (top) behind the glass, near (bottom) in front: median top ${median(top)} > median bottom ${median(bot)} px`, median(top) > median(bot) && median(bot) < 0, `top ${median(top)} bottom ${median(bot)}`);
            // the focus is the SURFACE at the centre, read from the drawn vertices (the page's tile origins sit
            // 150 units below its ground: focusing on them would put the centre in front of the glass)
            const mid = D.filter((b) => Math.abs(b.y + 8 - g.h / 2) < g.h * 0.06 && Math.abs(b.x + 8 - g.w / 4) < g.w * 0.12).map((b) => b.d);
            t(`${names[i]}: the surface at the centre of the view is at the glass (median ${median(mid)} px over ${mid.length} blocks), focus from the drawn vertices`, Math.abs(median(mid)) <= 1 && /vertices/.test((g.surf && g.surf.via) || ''), `focus ${g.stereo && g.stereo.C.toFixed(1)} via ${g.surf && g.surf.via}`);
          }
          const srt = all.slice().sort((p, q) => p - q), p2 = srt[Math.floor(0.02 * (srt.length - 1))], p98 = srt[Math.ceil(0.98 * (srt.length - 1))];
          t(`${names[i]}: disparity bounded by the comfort rule: 2nd..98th percentile within ±${lim} eye px`, Math.max(Math.abs(p2), Math.abs(p98)) <= lim, `p2 ${p2} p98 ${p98} (min ${srt[0]} max ${srt[srt.length - 1]})`);
          // (2+ px matches are reported, not judged: on a steep slope near the camera the horizontal disparity
          // changes within one block and a rigid block can match a sheared one better a row or two off.)
          t(`${names[i]}: no vertical disparity (median dy 0, mean within ±0.15 px)`, median(dys) === 0 && Math.abs(dyMean) <= 0.15, `median ${median(dys)} mean ${dyMean.toFixed(3)} (2+ px matches ${(dy2 * 100).toFixed(1)} %)`);
          const e = innerEdge(g.px, g.w, g.h);
          t(`${names[i]}: no seam at the inner edges (column std ≥ 4)`, e.min >= 4, `min ${e.min.toFixed(1)} mean ${e.mean.toFixed(1)}`);
          const lab = colourCentroids(g.px, g.w, g.h, [255, 0, 255]);
          t(`${names[i]}: labels in BOTH eyes at the same place (at the glass)`, lab[0].n > 50 && lab[1].n > 50 && Math.abs(lab[0].n - lab[1].n) < 0.1 * lab[0].n && Math.abs(lab[0].x - lab[1].x) < 1 && Math.abs(lab[0].y - lab[1].y) < 1, JSON.stringify(lab.map((l) => ({ n: l.n, x: +l.x.toFixed(1), y: +l.y.toFixed(1) }))));
        });
      },
    },
    {
      id: 'g-globe-golive-off', name: 'globe page: the layer follows a committed side-by-side frame under the cover (go-live), and turning off (Ctrl+Alt+3) never shows a raw pair; the page is idle (render on demand) throughout, so both rely on replay',
      url: P + 'globe-tiles.html', shim: NEW, cfg, fake, commits: true,
      async run(page, h) {
        const ok = await live(page);
        await page.waitForFunction(() => window.__frozen, { timeout: 15000 }).catch(() => {});
        await h.sleep(800); // idle: nothing draws now but our replays
        const framesBefore = await page.evaluate(() => window.__frames);
        await page.keyboard.down('Control'); await page.keyboard.down('Alt'); await page.keyboard.press('Digit3'); await page.keyboard.up('Alt'); await page.keyboard.up('Control');
        await h.sleep(1500);
        const res = await page.evaluate(() => ({ layers: window.__fakeXR.layers, closes: window.__fakeXR.closes, frames: window.__frames, state: window.__dxrAuto3D.state().renderers.map((r) => ({ active: r.active, releasing: r.releasing })) }));
        return { live: ok, framesBefore, ...res };
      },
      check(r, t, h) {
        t('converted', r.live, '');
        const g = h.goLiveCommitted((r.layers || []).map((l) => ({ store: l.storeAtCreate, committed: l.committedAtCreate })));
        t('go-live: the frame committed before each layer is the store, under the cover', g.n >= 1 && g.bad === 0, g.detail);
        const cl = (r.closes || [])[0];
        t('turned off: the layer closed, the canvas is 2D', !!cl && r.state.every((x) => !x.active && !x.releasing), JSON.stringify(r.state));
        if (!cl) return;
        // A raw pair here = two copies of (nearly) the same picture side by side: the halves match at shift 0.
        const halves = (f) => { const px = Buffer.from(f.px, 'base64'), w = 128, hh = 72, e = w / 2; let s = 0, n = 0; for (let y = 0; y < hh; y++) for (let x = 2; x < e - 2; x++) { s += Math.abs(h.lum(px, (y * w + x) * 4) - h.lum(px, (y * w + e + x) * 4)); n++; } return s / n; };
        const pairBase = Math.min(...cl.before.map(halves)), last = cl.after[cl.after.length - 1], monoBase = last ? halves(last) : NaN;
        const cut = (pairBase + monoBase) / 2;
        const frames = [cl.committed, ...cl.after].filter(Boolean);
        const bad = frames.map((f, i) => ({ i, e: halves(f), covered: f.covered })).filter((f) => f.e < cut && !f.covered);
        t('the check discriminates (live pair frames match their halves, the mono frame does not)', pairBase < 0.5 * monoBase, `pair ${pairBase.toFixed(1)} mono ${monoBase.toFixed(1)}`);
        t('no raw pair committed at or after the close (unless covered)', bad.length === 0, `${frames.length} frames, bad ${JSON.stringify(bad)}`);
        t('the page drew nothing itself meanwhile (the mono frame and the out-cover came from replay)', r.frames === r.framesBefore, `page frames ${r.framesBefore} -> ${r.frames}`);
      },
    },
    {
      id: 'g-globe-flat', name: 'globe page, straight down on a flat ground (a plain 2D map in perspective): never converted',
      url: P + 'globe-tiles.html?mode=flat', shim: NEW, cfg, fake,
      async run(page, h) { await h.sleep(9000); return { st: await stateOf(page) }; },
      check(r, t) { const S = r.st; t('stays 2D: no session, no globe renderer', S.fake.sessions === 0 && !S.renderers.some((x) => x.engine === 'WebGL globe'), JSON.stringify(S)); t('... the tap watched it and found no relief', !!S.globe && S.globe.length > 0 && S.globe.every((g) => !g.recognised), JSON.stringify(S.globe)); },
    },
    {
      id: 'g-globe-ortho', name: 'globe page, orthographic 2D map (no clip matrix at all): never converted',
      url: P + 'globe-tiles.html?mode=ortho', shim: NEW, cfg, fake,
      async run(page, h) { await h.sleep(9000); return { st: await stateOf(page) }; },
      check(r, t) { const S = r.st; t('stays 2D: no session, no globe renderer', S.fake.sessions === 0 && !S.renderers.some((x) => x.engine === 'WebGL globe'), JSON.stringify(S)); },
    },
    {
      id: 'g-globe-split', name: 'one projection for every draw + per-draw model-view (an engine\'s layout, not a tiled world): never converted',
      url: P + 'globe-tiles.html?mvp=split', shim: NEW, cfg, fake,
      async run(page, h) { await h.sleep(9000); return { st: await stateOf(page) }; },
      check(r, t) { const S = r.st; t('stays 2D: no session, no globe renderer', S.fake.sessions === 0 && !S.renderers.some((x) => x.engine === 'WebGL globe'), JSON.stringify(S)); },
    },
    {
      id: 'g-globe-three', name: 'three.js page: the globe route stays out (the three.js adapter converts it)',
      url: P + 'three-orbit.html', shim: NEW, cfg: { guardFps: 0 },
      async run(page, h) {
        await page.waitForFunction(() => { const s = window.__dxrAuto3D && window.__dxrAuto3D.state(); return !!(s && s.renderers.some((x) => x.active)); }, { timeout: 20000, polling: 200 }).catch(() => {});
        await h.sleep(5000);
        return { st: await stateOf(page) };
      },
      check(r, t) {
        const S = r.st;
        t('three.js converts the canvas', S.renderers.some((x) => x.active && /three/i.test(x.engine)), JSON.stringify(S.renderers));
        t('no globe renderer, and the globe tap left the canvas', !S.renderers.some((x) => x.engine === 'WebGL globe') && (!S.globe || S.globe.every((g) => !g.recognised)), JSON.stringify(S.globe));
      },
    },
  ];
}

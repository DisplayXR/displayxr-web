// Unit tests for the pixel analysis (no browser): synthetic stereo pairs with known disparity.
//   node --test plugins/displayxr-inline3d/checker/test/analyze.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentStats, compareEyes, blockDisparity, flatWideVerdict, sbsPairVerdict, halves, quantile, shibataZoneMm } from '../lib/analyze.mjs';
import { decodePng, encodePng } from '../lib/png.mjs';

function image(w, h, fn) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b, a = 255] = fn(x, y);
    const o = (y * w + x) * 4;
    data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = a;
  }
  return { width: w, height: h, data };
}
// Non-periodic texture (a hash), so block matching has one clear answer.
const noise = (x, y, s) => { let n = (x * 374761393 + y * 668265263 + s * 2147483647) | 0; n = (n ^ (n >>> 13)) * 1274126177; return ((n ^ (n >>> 16)) >>> 0) / 4294967296; };
const tex = (x, y, s) => noise(x >> 2, y >> 2, s); // 4 px cells
// A textured scene drawn per eye: background at disparity +2 (behind), a square at -6 (in front).
function eye(w, h, isRight) {
  return (x, y) => {
    const sq = x - (isRight ? -3 : 3), bg = x - (isRight ? 1 : -1);
    if (sq > w * 0.35 && sq < w * 0.65 && y > h * 0.3 && y < h * 0.7) { const t = tex(sq, y, 1); return [140 + 100 * t, 40 + 40 * t, 30]; }
    const t = tex(bg, y, 2);
    return [70 + 90 * t, 90 + 60 * t, 120];
  };
}
function sbs(w, h, left, right) {
  return image(w * 2, h, (x, y) => (x < w ? left(x, y) : right(x - w, y)));
}

test('contentStats: black, transparent and flat-filled pictures are blank; a scene is not', () => {
  assert.equal(contentStats(image(64, 32, () => [0, 0, 0, 255])).black, true);
  assert.equal(contentStats(image(64, 32, () => [0, 0, 0, 0])).transparent, true);
  assert.equal(contentStats(image(64, 32, () => [200, 200, 200, 255])).blank, true);
  assert.equal(contentStats(image(160, 80, eye(160, 80, false))).blank, false);
});

test('compareEyes: identical eyes are flagged; a real pair is not', () => {
  const L = image(160, 80, eye(160, 80, false));
  assert.equal(compareEyes(L, L).identical, true);
  const R = image(160, 80, eye(160, 80, true));
  const c = compareEyes(L, R);
  assert.equal(c.identical, false);
  assert.ok(c.madBest < 0.5 * c.baseline, JSON.stringify(c));
});

test('blockDisparity recovers the depth layers (− in front, + behind)', () => {
  const L = image(200, 100, eye(200, 100, false)), R = image(200, 100, eye(200, 100, true));
  const ds = blockDisparity(L, R).map((b) => b.d);
  assert.ok(ds.length > 10);
  assert.ok(Math.abs(quantile(ds, 0.05) + 6) < 1.2, `front ${quantile(ds, 0.05)}`);
  assert.ok(Math.abs(quantile(ds, 0.95) - 2) < 1.2, `back ${quantile(ds, 0.95)}`);
});

test('flatWideVerdict: one wide picture in the buffer is flagged; a stereo pair is not', () => {
  const w = 160, h = 80;
  const pair = sbs(w, h, eye(w, h, false), eye(w, h, true));
  assert.equal(flatWideVerdict(pair).flatWide, false);
  const wide = image(2 * w, h, (x, y) => { const t = tex(x, y, 3); return [60 + 150 * t, 80 + 100 * (x / (2 * w)), 90]; });
  assert.equal(flatWideVerdict(wide).flatWide, true);
});

test('sbsPairVerdict: a packed pair shown flat is flagged; an ordinary picture is not', () => {
  const w = 160, h = 90;
  assert.equal(sbsPairVerdict(sbs(w, h, eye(w, h, false), eye(w, h, true))).sbs, true);
  const photo = image(2 * w, h, (x, y) => [x % 255, (y * 3) % 255, ((x * y) >> 5) % 255]);
  assert.equal(sbsPairVerdict(photo).sbs, false);
});

test('halves split a buffer down the middle', () => {
  const [L, R] = halves(image(10, 2, (x) => [x * 20, 0, 0]));
  assert.equal(L.width, 5); assert.equal(R.width, 5);
  assert.equal(R.data[0], 100);
});

test('shibataZoneMm matches the SDK comfortZone at 0.65 m', () => {
  const z = shibataZoneMm(0.65);
  assert.ok(Math.abs(z.frontMm - 23.5) < 0.5, z.frontMm);
  assert.ok(Math.abs(z.behindMm - 25.3) < 0.5, z.behindMm);
});

test('png round trip', () => {
  const img = image(7, 5, (x, y) => [x * 30, y * 40, 7, 200]);
  const back = decodePng(encodePng(img));
  assert.deepEqual([...back.data], [...img.data]);
});

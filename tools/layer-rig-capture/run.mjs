// Headless stereo capture for handle.setLayerRig + makeSbsMaterial (docs/playcanvas-adapter.md).
//
//   npm i --no-save puppeteer-core            # once, anywhere on the resolve path
//   python3 -m http.server 8765 --bind 127.0.0.1   # from the repo root
//   CHROME=… PAGE="http://127.0.0.1:8765/tools/layer-rig-capture/index.html?path=cameras&controls=page" node tools/layer-rig-capture/run.mjs /tmp/out
//   (?path=renderview|cameras — the view path; &controls=page — the page owns the camera, stage in world space)
//
// ONE headless Chrome (ANGLE Metal on macOS), closed on exit. Writes result.json + cam3d/disp3d/mono PNGs.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const OUT = process.argv[2] || '.';
const URL = process.env.PAGE || `http://127.0.0.1:8765/tools/layer-rig-capture/index.html${process.argv[3] || ''}`;
fs.mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME,
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--force-device-scale-factor=1', `--user-data-dir=${OUT}/prof`, '--no-first-run'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 800, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(URL);
  await page.waitForFunction('window.__R && window.__R.done', { timeout: 120000 });
  const R = await page.evaluate(() => window.__R);
  for (const k of ['cam3d', 'disp3d']) if (R[k]?.png) { fs.writeFileSync(`${OUT}/${k}.png`, Buffer.from(R[k].png.split(',')[1], 'base64')); delete R[k].png; }
  if (R.mono?.png) { fs.writeFileSync(`${OUT}/mono.png`, Buffer.from(R.mono.png.split(',')[1], 'base64')); delete R.mono.png; }
  fs.writeFileSync(`${OUT}/result.json`, JSON.stringify(R, null, 1));
  if (R.error) { console.error(R.error); process.exitCode = 1; }
  const E = R.expect;
  for (const [rig, k] of [['camera', 'cam3d'], ['display', 'disp3d']]) {
    for (const name of ['contact', 'pop', 'behind']) {
      const got = R[k].m.map((e) => e[name]?.x);
      const exp = E[name][rig].map((e) => e.x);
      console.log(`${rig.padEnd(8)} ${name.padEnd(8)} L/R ${got.join(' / ')}  expected ${exp.map((x) => x.toFixed(2)).join(' / ')}  disparity ${(got[0] - got[1]).toFixed(1)} (expected ${(exp[0] - exp[1]).toFixed(2)})`);
    }
  }
  console.log('gain 1 == today:', R.gain1.hash === R.cam3d.hash, ' mono camera == display:', R.mono.cam.hash === R.mono.disp.hash);
  const pl = R.plane;
  const d = (m, k) => (m[0][k]?.x ?? NaN) - (m[1][k]?.x ?? NaN);
  console.log(`planeOffset ${pl.offset.toFixed(3)} m → planeM ${pl.state.planeM.toFixed(3)}: behind L/R ${pl.m.map((e) => e.behind?.x).join(' / ')} disparity ${d(pl.m, 'behind').toFixed(1)} (expected ${(pl.expectBehind[0].x - pl.expectBehind[1].x).toFixed(2)}); contact disparity ${d(pl.m, 'contact').toFixed(1)} (expected ${(pl.expectContact[0].x - pl.expectContact[1].x).toFixed(2)}); pop ${d(pl.m, 'pop').toFixed(1)} (expected ${(pl.expectPop[0].x - pl.expectPop[1].x).toFixed(2)})`);
  console.log('state (display, 3D):', JSON.stringify(R.disp3d.state));
  console.log('WARN lines:'); for (const w of R.warns) console.log('  ' + w);
} finally {
  await browser.close();
}

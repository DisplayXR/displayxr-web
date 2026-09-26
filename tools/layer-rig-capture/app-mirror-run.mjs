// Runs app-mirror.html in ONE headless Chrome and prints each stage. See app-mirror.js.
//   python3 -m http.server 8791 --bind 127.0.0.1   (from a dir that holds the page and the assets)
//   CHROME=… PAGE="http://127.0.0.1:8791/…/app-mirror.html?a=<A.sog>&b=<B.sog>[&sdk=<dir>][&path=cameras]" node app-mirror-run.mjs <outdir>
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const OUT = process.argv[2] || '.';
fs.mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME, headless: 'new', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--force-device-scale-factor=1', `--user-data-dir=${OUT}/prof`, '--no-first-run'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 800, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(process.env.PAGE);
  await page.waitForFunction('window.__R && window.__R.done', { timeout: 240000 });
  const R = await page.evaluate(() => window.__R);
  fs.writeFileSync(`${OUT}/result.json`, JSON.stringify(R, null, 1));
  if (R.error) console.log('ERROR', R.error);
  for (const s of R.stages) {
    const st = s.state;
    console.log(`${s.label}\n   D=${s.D.toFixed(3)}  engaged=${st.engaged ?? '-'} rounded=${st.rounded} path=${st.path ?? '-'} gain=${st.gain?.toFixed?.(3)} reason=${st.reason ?? '-'}\n   pop disparity ${s.popDisparity?.toFixed(1)} px (display-rig expect ${s.expectDisplay.toFixed(2)}, camera-rig ${s.expectCamera.toFixed(2)}); contact disparity ${s.contactDisparity?.toFixed(1)}\n   blended (StageAfterSplat) disparity ${s.popT.disparity?.toFixed(1)} px (display-rig expect ${s.popT.expectDisplay.toFixed(2)}, camera-rig ${s.popT.expectCamera.toFixed(2)}); eye layers [${s.eyeLayers}]`);
  }
  for (const w of R.warns) console.log('WARN', w);
} finally {
  await browser.close();
}

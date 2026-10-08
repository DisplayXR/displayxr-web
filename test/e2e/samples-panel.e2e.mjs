#!/usr/bin/env node
// test/e2e/samples-panel.e2e.mjs — the published samples, one by one, in the REAL DisplayXR
// Browser on a 3D panel (LOXR-826: the 3D scene samples):
//
//   node test/e2e/samples-panel.e2e.mjs                 # all samples in SAMPLES
//   node test/e2e/samples-panel.e2e.mjs hello-cube      # just these
//
// Per sample, a fresh browser launch on the live site (BASE, default the GitHub Pages site), then:
//   1. loads   — no page error and no console error in the browser's own log (chrome_debug.log,
//                which covers page startup; the CDP listeners only cover what follows the attach);
//   2. 3D      — the sample's own "woven" signal (its status line / class), AND the runtime
//                received a weave submit whose rect is the canvas (the service's one-shot
//                weave-input dump, `#73 diag` lines in the displayxr-service log);
//   3. input   — the sample's control does what it says (a state change the page reports), where
//                the sample has one; hello-cube has none (head tracking only);
//   4. a full-screen grab for review.
//
// Automation is attached only AFTER the page has settled (SETTLE_MS): attaching while a woven page
// starts up and polling it is known to provoke a raw side-by-side "double" image in the browser.
// Input goes through CDP (Input.dispatchMouseEvent), so the real mouse is never moved.
//
// Windows only (the service log, the %TEMP% weave trigger, ffmpeg ddagrab). Needs puppeteer-core
// (`npm i --no-save puppeteer-core`), the DisplayXR Browser (BROWSER, default the installed path)
// and a running displayxr-service. Not part of `npm test`: it needs the panel and ~1 min/sample.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = (process.env.BASE || 'https://displayxr.github.io/displayxr-web').replace(/\/$/, '');
const BROWSER = process.env.BROWSER || 'C:\\Program Files\\DisplayXR\\Browser\\chrome.exe';
const FFMPEG = process.env.FFMPEG || 'C:\\tools\\ffmpeg.exe';
const PORT = +(process.env.CDP_PORT || 9351);
const SETTLE_MS = +(process.env.SETTLE_MS || 10000);
const TEMP = process.env.TEMP;
const SVC_LOG_DIR = join(process.env.LOCALAPPDATA || '', 'DisplayXR');
const OUT = resolve(process.env.OUT || join(root, 'test', 'e2e', 'out', 'samples-panel', stamp()));
const PROFILE = join(OUT, 'profile');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ── the samples ─────────────────────────────────────────────────────────────────────────────
// woven(): evaluated in the page; true once the sample says it is weaving.
// input(page): drives the sample's control and returns { ok, detail }, or null when it has none.
const SAMPLES = {
  'hello-cube': {
    path: 'samples/hello-cube/',
    canvas: '#cube',
    woven: () => /inline-3D active/.test(document.getElementById('status')?.textContent || ''),
    input: null, // no controls: the cube spins and follows the viewer's head
  },
  model: {
    path: 'samples/model/',
    canvas: '#tileA',
    woven: () => {
      const notes = ['noteA', 'noteB', 'noteC'].map((id) => document.getElementById(id)?.textContent || '');
      return notes.every((t) => t && !/loading…|failed|open in the DisplayXR Browser/.test(t));
    },
    input: async (page) => {
      const before = await text(page, '#sweep');
      await page.click('#sweep');
      await sleep(500);
      const after = await text(page, '#sweep');
      await page.click('#sweep'); // put it back
      return { ok: before !== after, detail: `fit button "${before}" -> "${after}"` };
    },
  },
  splat: {
    path: 'samples/splat/',
    canvas: '#tile',
    woven: () => /woven glasses-free 3D/.test(document.getElementById('status')?.textContent || ''),
    input: async (page) => {
      const before = await text(page, '#spin');
      await page.click('#spin');
      await sleep(500);
      const after = await text(page, '#spin');
      await page.click('#spin');
      return { ok: before !== after, detail: `turntable button "${before}" -> "${after}"` };
    },
  },
  'camera-rig': {
    path: 'samples/camera-rig/',
    canvas: '#stage',
    woven: () => document.getElementById('status')?.classList.contains('woven') === true,
    // The readout shows rig/convergence/comfort, not the orbit angle, so the evidence is the
    // sample's own drag state (it adds .dragging on pointerdown) plus the canvas picture moving.
    // A CDP element screenshot does not show a woven canvas's content, so the picture is read off
    // the screen (Desktop Duplication) over the canvas's weave rect.
    // The baseline is the same interval with no input, so a scene that animates on its own (or a
    // tracked viewer moving) cannot pass for an orbit.
    input: async (page, rect) => {
      const a = grabRegion(rect);
      await sleep(800);
      const b = grabRegion(rect);
      let grabbed = false;
      await drag(page, '#stage', 220, 0, async () => {
        grabbed = await page.$eval('#stage', (c) => c.classList.contains('dragging'));
      });
      await sleep(500);
      const idle = meanAbsDiff(a, b);
      const dragged = meanAbsDiff(b, grabRegion(rect));
      const moved = dragged > Math.max(2, 3 * idle);
      return {
        ok: grabbed && moved,
        detail: `drag to orbit: handler ${grabbed ? 'engaged' : 'did not engage'}; on-screen canvas change ${dragged.toFixed(1)} after the drag vs ${idle.toFixed(1)} with no input (needs > max(2, 3x idle))`,
      };
    },
  },
  'display-modes': {
    path: 'samples/display-modes/',
    canvas: '#tile',
    woven: () => document.getElementById('status')?.classList.contains('woven') === true,
    // On a 3D panel the page must be able to read what the panel is. The startup read is what a
    // visitor sees; "Re-read modes" is reported alongside it, to tell a startup race from a
    // display-info read that never works.
    extra: async (page) => {
      const infoText = () => page.$eval('#info', (el) => el.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
      const atStart = await infoText();
      await page.waitForFunction(() => !document.getElementById('refresh')?.disabled, { timeout: 10000 }).catch(() => {});
      await page.click('#refresh');
      await sleep(1500);
      const afterReread = await infoText();
      const none = (t) => !t || /none — no glasses-free display/.test(t) || /not read yet/.test(t);
      return {
        displayInfo: {
          ok: !none(atStart),
          detail: `at page start: "${atStart.slice(0, 120)}"; after Re-read: "${afterReread.slice(0, 120)}"`,
        },
      };
    },
    input: async (page) => {
      await page.waitForFunction(() => !document.getElementById('stereo')?.disabled, { timeout: 10000 });
      const before = await text(page, '#stereo');
      await page.click('#stereo');
      await page.waitForFunction((b) => document.getElementById('stereo')?.textContent !== b, { timeout: 8000 }, before).catch(() => {});
      const after = await text(page, '#stereo');
      await sleep(1500);
      await page.click('#stereo'); // back to where it was
      await page.waitForFunction((b) => document.getElementById('stereo')?.textContent === b, { timeout: 8000 }, before).catch(() => {});
      const restored = await text(page, '#stereo');
      return { ok: before !== after && restored === before, detail: `mode button "${before}" -> "${after}" -> "${restored}"` };
    },
  },
};

async function text(page, sel) {
  return page.$eval(sel, (el) => el.textContent.trim()).catch(() => '');
}

async function drag(page, sel, dx, dy, midway) {
  const box = await (await page.$(sel)).boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(x + (dx * i) / 10, y + (dy * i) / 10);
    if (i === 5 && midway) await midway();
    await sleep(16);
  }
  await page.mouse.up();
}

// ── plumbing ────────────────────────────────────────────────────────────────────────────────
async function loadPuppeteer() {
  const req = createRequire(join(process.env.PUPPETEER_CORE || root, 'package.json'));
  return (await import(pathToFileURL(req.resolve('puppeteer-core')).href)).default;
}

async function waitForCdp() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('the browser never opened its DevTools port');
}

// Every log file of the live service process (it writes two per PID).
function serviceLogs() {
  if (!existsSync(SVC_LOG_DIR)) return [];
  const all = readdirSync(SVC_LOG_DIR)
    .filter((f) => /^DisplayXR_displayxr-service\.exe\.\d+_.*\.log$/.test(f))
    .map((f) => ({ f: join(SVC_LOG_DIR, f), t: statSync(join(SVC_LOG_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!all.length) return [];
  const pid = all[0].f.match(/\.exe\.(\d+)_/)[1];
  return all.filter((x) => x.f.includes(`.exe.${pid}_`)).map((x) => x.f);
}

const logTime = (s) => {
  const m = s.match(/^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3})\]/);
  return m ? new Date(m[1].replace(' ', 'T')).getTime() : NaN;
};

// One weave-input dump: the next weave submit logs its rect list. Returns the rects.
async function weaveSubmitRects(since) {
  writeFileSync(join(TEMP, 'dxr_weave_dump_trigger'), '');
  for (let i = 0; i < 24; i++) {
    await sleep(250);
    const lines = serviceLogs()
      .flatMap((f) => readFileSync(f, 'utf8').split(/\r?\n/))
      .filter((l) => l.includes('#73 diag') && logTime(l) >= since);
    const submit = lines.find((l) => /#73 diag: submit n=/.test(l));
    if (submit) {
      await sleep(3500); // the dump writes three large PNGs; let it finish before the next sample
      const rects = lines
        .map((l) => l.match(/rect\[\d+\] = (-?\d+),(-?\d+) (\d+)x(\d+)/))
        .filter(Boolean)
        .map((m) => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }));
      for (const f of readdirSync(TEMP).filter((f) => /^dxr73_weave_.*\.png$/.test(f))) rmSync(join(TEMP, f), { force: true });
      return { submit: submit.replace(/^.*#73 diag: /, ''), rects };
    }
  }
  rmSync(join(TEMP, 'dxr_weave_dump_trigger'), { force: true });
  return null;
}

function browserLogFindings(file, attachedAt) {
  if (!existsSync(file)) return { errors: ['chrome_debug.log missing'], withheldAfterSettle: 0, binds: 0 };
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const errors = lines
    .filter((l) => /:(ERROR|WARNING):CONSOLE\(|INFO:CONSOLE.*(Uncaught|Error:)/.test(l) && !/favicon/.test(l))
    .map((l) => l.slice(0, 300));
  // chrome_debug.log stamps are local MMDD/HHMMSS.mmm
  const stampMs = (l) => {
    const m = l.match(/:\d{4}\/(\d\d)(\d\d)(\d\d)\.(\d{3}):/);
    if (!m) return NaN;
    const d = new Date(attachedAt);
    d.setHours(+m[1], +m[2], +m[3], +m[4]);
    return d.getTime();
  };
  const withheldAfterSettle = lines.filter((l) => /inline-3D withheld/.test(l) && stampMs(l) >= attachedAt).length;
  const binds = lines.filter((l) => /present-owner session bound/.test(l)).length;
  return { errors, withheldAfterSettle, binds };
}

// The screen over a weave rect (window coordinates == screen coordinates for the maximised
// window), as 8-bit grey, for before/after comparisons.
function grabRegion(r) {
  if (!r) return null;
  const w = r.w & ~1;
  const h = r.h & ~1;
  try {
    return execFileSync(FFMPEG, ['-loglevel', 'error', '-f', 'lavfi', '-i',
      `ddagrab=output_idx=0:framerate=10:offset_x=${r.x}:offset_y=${r.y}:video_size=${w}x${h}`,
      '-vf', 'hwdownload,format=bgra,format=gray', '-frames:v', '1', '-f', 'rawvideo', '-'], { timeout: 15000, maxBuffer: 64 << 20 });
  } catch {
    return null;
  }
}

function meanAbsDiff(a, b) {
  if (!a || !b || a.length !== b.length) return NaN;
  let s = 0;
  for (let i = 0; i < a.length; i += 7) s += Math.abs(a[i] - b[i]);
  return s / Math.ceil(a.length / 7);
}

function grabScreen(file) {
  try {
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'ddagrab=output_idx=0:framerate=10',
      '-vf', 'hwdownload,format=bgra', '-frames:v', '1', file], { timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

// ── one sample ──────────────────────────────────────────────────────────────────────────────
async function runSample(puppeteer, name, spec) {
  const url = `${BASE}/${spec.path}`;
  const dir = join(OUT, name);
  mkdirSync(dir, { recursive: true });
  const res = { name, url, checks: {}, pass: false };
  const proc = spawn(BROWSER, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run',
    '--hide-crash-restore-bubble', '--enable-logging', '--v=1', '--start-maximized', url], { stdio: 'ignore' });
  let browser;
  try {
    await waitForCdp();
    await sleep(SETTLE_MS); // let the page start and weave with nothing attached
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
    const attachedAt = Date.now();
    const target = await browser.waitForTarget((t) => t.type() === 'page' && t.url().startsWith(url), { timeout: 10000 });
    const page = await target.page();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));

    // 2. the sample's own woven signal
    const woven = await page.waitForFunction(spec.woven, { timeout: 20000 }).then(() => true, () => false);
    const status = await page.evaluate(() =>
      (document.getElementById('status')?.textContent ||
        ['noteA', 'noteB', 'noteC'].map((id) => document.getElementById(id)?.textContent || '').join(' | ')).trim());
    res.checks.wovenSignal = { ok: woven, detail: status.slice(0, 200) };

    // 2b. the runtime got a weave submit whose rect is this canvas
    const cr = await page.$eval(spec.canvas, (c) => {
      const r = c.getBoundingClientRect();
      const d = window.devicePixelRatio || 1;
      return { w: Math.round(r.width * d), h: Math.round(r.height * d) };
    });
    const sub = await weaveSubmitRects(Date.now() - 50);
    const match = sub?.rects.find((r) => Math.abs(r.w - cr.w) <= 4 && Math.abs(r.h - cr.h) <= 4);
    res.checks.weaveSubmit = {
      ok: !!match,
      detail: sub ? `${sub.submit}; rects ${sub.rects.map((r) => `${r.x},${r.y} ${r.w}x${r.h}`).join(' | ')}; canvas ${cr.w}x${cr.h}` : 'no weave submit seen within 6 s',
    };

    // sample-specific checks
    if (spec.extra) Object.assign(res.checks, await spec.extra(page).catch((e) => ({ extra: { ok: false, detail: `threw: ${e.message}` } })));

    // 3. input
    if (spec.input) res.checks.input = await spec.input(page, match).catch((e) => ({ ok: false, detail: `threw: ${e.message}` }));
    else res.checks.input = { ok: true, detail: 'n/a: no controls (head tracking only)' };

    // 4. review grab
    await sleep(1000);
    res.screen = grabScreen(join(dir, 'screen.png')) ? 'screen.png' : null;

    // 1. errors (page listeners after attach + the browser log from launch)
    await browser.disconnect();
    browser = null;
    res.checks.pageErrors = { ok: pageErrors.length === 0, detail: pageErrors.slice(0, 5) };
    res._attachedAt = attachedAt;
  } catch (e) {
    res.checks.harness = { ok: false, detail: e.message };
  } finally {
    if (browser) await browser.disconnect().catch(() => {});
    try {
      execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
    await sleep(1500);
  }
  const log = join(PROFILE, 'chrome_debug.log');
  if (existsSync(log)) copyFileSync(log, join(dir, 'chrome_debug.log'));
  const f = browserLogFindings(join(dir, 'chrome_debug.log'), res._attachedAt || Date.now());
  res.checks.consoleErrors = { ok: f.errors.length === 0, detail: f.errors.slice(0, 5) };
  res.browserLog = { binds: f.binds, withheldAfterSettle: f.withheldAfterSettle };
  delete res._attachedAt;
  res.pass = Object.values(res.checks).every((c) => c.ok);
  writeFileSync(join(dir, 'result.json'), JSON.stringify(res, null, 1));
  return res;
}

async function main() {
  if (!existsSync(BROWSER)) throw new Error(`DisplayXR Browser not found at ${BROWSER} (set BROWSER)`);
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SAMPLES);
  for (const n of names) if (!SAMPLES[n]) throw new Error(`unknown sample ${n}; known: ${Object.keys(SAMPLES).join(', ')}`);
  mkdirSync(OUT, { recursive: true });
  const puppeteer = await loadPuppeteer();
  const results = [];
  for (const n of names) {
    const r = await runSample(puppeteer, n, SAMPLES[n]);
    results.push(r);
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${n}`);
    for (const [k, c] of Object.entries(r.checks)) console.log(`      ${c.ok ? 'ok  ' : 'FAIL'} ${k}: ${typeof c.detail === 'string' ? c.detail : JSON.stringify(c.detail)}`);
  }
  writeFileSync(join(OUT, 'results.json'), JSON.stringify({ base: BASE, browser: BROWSER, results }, null, 1));
  console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed · ${OUT}`);
  process.exitCode = results.every((r) => r.pass) ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 2;
});

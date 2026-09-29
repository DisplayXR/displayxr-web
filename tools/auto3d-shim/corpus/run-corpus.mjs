// No-harm corpus runner for tools/auto3d-shim — the P4 gate (design §3.9, §4 row 4).
//
// For every site in sites.json it makes TWO loads in fresh incognito contexts of real-GPU headless
// Chrome (puppeteer-core, run.mjs's launch flags incl. --disable-features=OpenXR,WebXR):
//   control   fake-xr.js + the PROBE below                      (what the page does on its own)
//   injected  fake-xr.js + the PROBE + the PRODUCT bundle       (what the browser would inject)
// The product bundle is the COMMITTED dist/auto3d-sentinel.js + dist/auto3d-core.js (what the
// browser vendors, checked against VENDOR.json), evaluated by ../test/fake-host.js exactly as the
// harness's product cases do, with host decision 'allow'. Both texts get a //# sourceURL
// (dxr-auto3d-sentinel.js / dxr-auto3d-core.js) so a stack frame, timer or exception can be
// attributed to OUR code rather than the page's.
//
// Per site it records: loadCore called?, the engine detected, the outcome (converted / flat (why) /
// standdown / offer / none / error), the sentinel's evaluation ms, the page-visible surface diff vs
// the control load (new window keys; own-property descriptors on Object / EventTarget / Node /
// Element / HTMLElement / HTMLCanvasElement / Document / Window prototypes), timers our code created
// and left pending, console errors introduced, and uncaught exceptions whose stack is ours. Each site
// gets PASS / REVIEW / FAIL against the §3.3 budget (README.md, "What no harm means").
//
// Usage: node run-corpus.mjs [--sample] [--group plain|engine|sdk] [--only id,id] [--budget-ms 30000] [--keep]
//   env: CHROME=<binary>   Output: results/<date>[-sample].json + .md (--keep: PNGs in results/<date>/)
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = dirname(fileURLToPath(import.meta.url));
const shimDir = join(here, '..');
const WIN = process.platform === 'win32';
const CHROME = process.env.CHROME || (WIN ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');
const ANGLE = WIN ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'vulkan';
const W = 1280, H = 720;

// ------------------------------------------------------------ args
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SAMPLE = flag('--sample');
const KEEP = flag('--keep') || !!process.env.KEEP;
const GROUP = opt('--group', null);
const ONLY = opt('--only', '').split(',').filter(Boolean);
const BUDGET_MS = Number(opt('--budget-ms', 30000)); // navigation budget per load
// How long to watch a page after load, per group (engines: detection + the 1.2 s switch + frames).
const SETTLE_MS = { plain: 6000, engine: 12000, sdk: 10000 };

// ------------------------------------------------------------ the §3.3 budget
const BUDGET = {
  sentinelMs: 0.5,                                   // document-start cost (eval + run)
  allowedProto: new Set(['HTMLCanvasElement.getContext (changed)']),
  allowedKeys: new Set(['__THREE_DEVTOOLS__']),      // every page
  allowedKeysWebGL: new Set(['__THREE_DEVTOOLS__', 'pc']), // + the PlayCanvas route, armed on the first WebGL context
  moReviewMs: 5,                                     // our MutationObserver's total callback time: REVIEW above
};
const HARNESS_KEYS = new Set(['__dxrCorpusProbe', '__dxrFakeHost', '__dxrFakeHostSrc', '__dxrFakeHostCfg']);
const OURS = /dxr-auto3d-(sentinel|core)\.js/; // the sourceURLs given to the two product texts
const OURS_LOOSE = /dxr-auto3d|auto3d|\bdxr[A-Z]\w*/; // + part-function names (every part is `function dxr…`)

// ------------------------------------------------------------ injected scripts
const read = (p) => readFileSync(join(shimDir, p), 'utf8');
const SENTINEL = read('dist/auto3d-sentinel.js');
const CORE = read('dist/auto3d-core.js');
const VENDOR = JSON.parse(read('VENDOR.json'));
const sha = (s) => createHash('sha256').update(s).digest('hex');
for (const [f, t] of [['dist/auto3d-sentinel.js', SENTINEL], ['dist/auto3d-core.js', CORE]]) {
  const v = VENDOR.files && VENDOR.files[f];
  if (v && v.sha256 && v.sha256 !== sha(t)) console.warn(`WARNING: ${f} does not match VENDOR.json (run node build.mjs)`);
}
const PRODUCT_SRC = { sentinel: SENTINEL + '\n//# sourceURL=dxr-auto3d-sentinel.js', core: CORE + '\n//# sourceURL=dxr-auto3d-core.js' };
const FAKE_XR = readFileSync(join(shimDir, 'test', 'fake-xr.js'), 'utf8');
const FAKE_HOST = readFileSync(join(shimDir, 'test', 'fake-host.js'), 'utf8');
const PRODUCT = [`window.__dxrFakeHostSrc = ${JSON.stringify(PRODUCT_SRC)}; window.__dxrFakeHostCfg = ${JSON.stringify({ decision: 'allow' })};`, FAKE_HOST];

// Injected after fake-xr.js and BEFORE the product bundle, in BOTH loads (so its own changes cancel
// out). Snapshots window keys + prototype descriptors, counts WebGL contexts, records every timer
// with the stack that made it, and times the callbacks of MutationObservers constructed by our code.
const PROBE = `(() => {
  const OURS = ${OURS};
  const protos = { Object: Object.prototype, EventTarget: EventTarget.prototype, Node: Node.prototype, Element: Element.prototype,
    HTMLElement: HTMLElement.prototype, HTMLCanvasElement: HTMLCanvasElement.prototype, Document: Document.prototype, Window: Window.prototype };
  // WebGL context count: wrapped BEFORE the snapshot, so it is not itself a diff.
  const gc = HTMLCanvasElement.prototype.getContext; let webgl = 0;
  HTMLCanvasElement.prototype.getContext = function getContext(type, ...a) {
    const r = gc.call(this, type, ...a); if (r && /webgl/i.test(String(type))) webgl++; return r;
  };
  const keys0 = Object.getOwnPropertyNames(window);
  const snap = (o) => { const m = new Map(); for (const k of Reflect.ownKeys(o)) m.set(k, Object.getOwnPropertyDescriptor(o, k)); return m; };
  const before = {}; for (const n of Object.keys(protos)) before[n] = snap(protos[n]);
  const same = (a, b) => !!a && !!b && a.get === b.get && a.set === b.set && a.value === b.value && a.enumerable === b.enumerable && a.configurable === b.configurable && a.writable === b.writable;
  const stack = () => new Error().stack || '';
  const pending = new Map(); const ours = { created: 0, where: [] };
  const note = (id, kind, ms) => { const s = stack(); if (OURS.test(s)) { ours.created++; if (ours.where.length < 5) ours.where.push(kind + ' ' + ms + ' ms: ' + s.split('\\n').slice(3, 6).map((x) => x.trim()).join(' < ')); pending.set(id, kind + ' ' + ms + ' ms'); } };
  const sT = setTimeout, sI = setInterval, cT = clearTimeout, cI = clearInterval;
  window.setTimeout = function setTimeout(fn, ms, ...a) { const id = sT(function () { pending.delete(id); if (typeof fn === 'function') return fn.apply(this, a); }, ms); note(id, 'timeout', ms); return id; };
  window.setInterval = function setInterval(fn, ms, ...a) { const id = sI(fn, ms, ...a); note(id, 'interval', ms); return id; };
  window.clearTimeout = function clearTimeout(id) { pending.delete(id); return cT(id); };
  window.clearInterval = function clearInterval(id) { pending.delete(id); return cI(id); };
  const MO0 = window.MutationObserver; const mo = { ms: 0, calls: 0, observers: 0 };
  window.MutationObserver = function MutationObserver(cb) {
    if (!OURS.test(stack())) return new MO0(cb);
    mo.observers++;
    return new MO0(function (recs, o) { const t0 = performance.now(); try { return cb.call(this, recs, o); } finally { mo.ms += performance.now() - t0; mo.calls++; } });
  };
  window.MutationObserver.prototype = MO0.prototype;
  Object.defineProperty(window, '__dxrCorpusProbe', { value: {
    read() {
      const protoChanges = [];
      for (const n of Object.keys(protos)) {
        const b = before[n], a = snap(protos[n]);
        for (const [k, d] of a) if (!same(d, b.get(k))) protoChanges.push(n + '.' + String(k) + (b.has(k) ? ' (changed)' : ' (added)'));
        for (const k of b.keys()) if (!a.has(k)) protoChanges.push(n + '.' + String(k) + ' (removed)');
      }
      const k0 = new Set(keys0);
      const H = window.__dxrFakeHost || null;
      let engineOracle = [];
      try { if (window.__THREE__) engineOracle.push('three.js r' + window.__THREE__); } catch (e) {}
      try { if (window.pc && window.pc.version) engineOracle.push('playcanvas ' + window.pc.version); } catch (e) {}
      try { if (window.BABYLON) engineOracle.push('babylon'); } catch (e) {}
      try { if (typeof window.createUnityInstance === 'function' || window.unityInstance) engineOracle.push('unity'); } catch (e) {}
      return {
        newKeys: Object.getOwnPropertyNames(window).filter((k) => !k0.has(k)), protoChanges, webgl,
        pcInWindow: 'pc' in window, ours: { ...ours, pending: [...pending.values()] }, mo: { ...mo }, engineOracle,
        host: H && { loadCore: H.loadCore, sentinelMs: H.sentinelMs, coreEvalMs: H.coreEvalMs, saves: H.saves.length,
          reports: H.reports.map(({ status, engine, reason, t }) => ({ status, engine: engine || null, reason: reason || null, t: Math.round(t) })) },
        title: document.title, url: location.href, els: document.getElementsByTagName('*').length,
        text: (document.body && document.body.innerText || '').length, canvases: document.getElementsByTagName('canvas').length,
      };
    },
  } });
})();`;

// ------------------------------------------------------------ one load
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: timed out after ${ms} ms`)), ms))]);
const norm = (s) => String(s).replace(/https?:\/\/[^\s)'"]+/g, (u) => u.split('?')[0]).replace(/\d+/g, '#').slice(0, 200);

async function load(browser, site, injected) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const out = { errors: [], pageErrors: [], ourLogs: [], nav: null };
  try {
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
    await page.setBypassCSP(true); // the real host injects outside CSP; the fake host evals — both loads alike
    const ua = (await browser.userAgent()).replace('HeadlessChrome', 'Chrome');
    await page.setUserAgent(ua);
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    page.on('console', (m) => {
      const t = m.text();
      if (/dxr-auto3d/.test(t)) out.ourLogs.push(`[${m.type()}] ${t.slice(0, 200)}`);
      if (m.type() === 'error') out.errors.push(t.slice(0, 300));
    });
    page.on('pageerror', (e) => out.pageErrors.push({ msg: String((e && e.message) || e).slice(0, 300), stack: String((e && e.stack) || '').slice(0, 1200) }));
    await page.evaluateOnNewDocument('window.__fakeXROpts = {};');
    await page.evaluateOnNewDocument(FAKE_XR);
    await page.evaluateOnNewDocument(PROBE);
    if (injected) for (const s of PRODUCT) await page.evaluateOnNewDocument(s);
    const t0 = Date.now();
    try {
      const res = await page.goto(site.url, { waitUntil: 'load', timeout: BUDGET_MS });
      out.nav = { ok: true, status: res ? res.status() : null, ms: Date.now() - t0 };
    } catch (e) {
      // A load that never fires `load` in budget is still a page (ads, long-poll): keep going if it has a document.
      const hasDoc = await withTimeout(page.evaluate(() => !!document.body), 3000, 'doc').catch(() => false);
      out.nav = { ok: hasDoc, status: null, ms: Date.now() - t0, error: String(e.message || e).slice(0, 160), partial: hasDoc };
    }
    if (out.nav.ok) {
      // Watch the page: engines get the whole window; a terminal report ends it 2 s early.
      const tEnd = Date.now() + (SETTLE_MS[site.group] || 8000);
      while (Date.now() < tEnd) {
        await new Promise((r) => setTimeout(r, 500));
        if (!injected) continue;
        const last = await withTimeout(page.evaluate(() => { const H = window.__dxrFakeHost; const r = H && H.reports[H.reports.length - 1]; return r ? r.status : null; }), 3000, 'poll').catch(() => null);
        if (['live', 'flat', 'standdown', 'guard', 'optout'].includes(last) && tEnd - Date.now() > 2000) { await new Promise((r) => setTimeout(r, 2000)); break; }
      }
      out.fps = await withTimeout(page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1500) requestAnimationFrame(f); else res(Math.round((n * 1000) / (performance.now() - t0))); }; requestAnimationFrame(f); })), 5000, 'fps').catch(() => null);
      out.probe = await withTimeout(page.evaluate(() => window.__dxrCorpusProbe ? window.__dxrCorpusProbe.read() : null), 10000, 'probe').catch((e) => ({ error: String(e.message || e) }));
      if (KEEP) out.png = await withTimeout(page.screenshot({ type: 'png' }), 10000, 'shot').catch(() => null);
      // Warm cost: the first load above is COLD (fresh context, no V8 code/compilation cache). The §3.3
      // figure is per document on a browser that has run the scripts before, so two reloads in the same
      // context give the warm sentinel cost the budget is judged on (median of 3, as test/cases/sentinel.mjs
      // s-cost takes a median: one reload on a busy box can spike to 1-2 ms).
      if (injected) {
        out.warm = [];
        for (let i = 0; i < 3; i++) {
          try {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: BUDGET_MS });
            await new Promise((r) => setTimeout(r, 300));
            const ms = await withTimeout(page.evaluate(() => (window.__dxrFakeHost ? window.__dxrFakeHost.sentinelMs : null)), 5000, 'warm');
            if (ms != null) out.warm.push(ms);
          } catch { /* a reload that fails leaves fewer warm samples */ }
        }
      }
    }
  } finally {
    await ctx.close().catch(() => {});
  }
  return out;
}

// ------------------------------------------------------------ judging
function outcomeOf(P) {
  const H = P && P.host;
  if (!H) return { outcome: 'error', why: 'no host record (bundle did not run)' };
  const R = H.reports, last = R[R.length - 1];
  const engine = (R.find((r) => r.engine) || {}).engine || null;
  if (R.some((r) => r.status === 'live')) return { outcome: last.status === 'live' ? 'converted' : `converted, then ${last.status}${last.reason ? ' (' + last.reason + ')' : ''}`, engine };
  if (!last) return { outcome: H.loadCore ? 'core loaded, no report' : 'none', engine };
  const map = { flat: 'flat', guard: 'flat', standdown: 'standdown', offer: 'offer', optout: 'optout', off: 'off', converting: 'converting (never live)', idle: 'idle' };
  return { outcome: (map[last.status] || last.status) + (last.reason ? ` (${last.status === 'guard' ? 'guard: ' : ''}${last.reason})` : ''), engine };
}

function judge(site, C, I) {
  const fail = [], review = [];
  const row = { id: site.id, group: site.group, url: site.url };
  if (!I.nav || !I.nav.ok) {
    if (!C.nav || !C.nav.ok) return { ...row, verdict: 'ERROR', outcome: 'error', reasons: [`site unreachable in both loads: ${(I.nav && I.nav.error) || 'n/a'}`] };
    fail.push(`loads without injection, NOT with it: ${I.nav && I.nav.error}`);
    return { ...row, verdict: 'FAIL', outcome: 'error', reasons: fail };
  }
  const P = I.probe || {}, Q = (C.probe && !C.probe.error) ? C.probe : null;
  if (P.error) return { ...row, verdict: 'ERROR', outcome: 'error', reasons: [`probe read failed: ${P.error}`] };
  const { outcome, engine } = outcomeOf(P);
  const webgl = (P.webgl || 0) > 0 || (Q && Q.webgl > 0);
  const H = P.host || {};
  Object.assign(row, {
    outcome, engine, loadCore: H.loadCore || 0, sentinelMs: H.sentinelMs != null ? +H.sentinelMs.toFixed(3) : null,
    coreEvalMs: H.coreEvalMs ? +H.coreEvalMs.toFixed(1) : 0, webglContexts: P.webgl || 0, engineOracle: Q ? Q.engineOracle : null,
    fps: { control: C.fps ?? null, injected: I.fps ?? null }, moMs: P.mo ? +P.mo.ms.toFixed(2) : null,
    reports: (H.reports || []).map((r) => `${r.status}${r.engine ? ':' + r.engine : ''}${r.reason ? '(' + r.reason + ')' : ''}@${r.t}`),
    title: P.title, finalUrl: P.url, partialLoad: !!I.nav.partial,
  });
  // 1. document-start cost: judged WARM (median of the reloads); the cold first load is recorded
  row.sentinelMsCold = row.sentinelMs;
  row.sentinelMsWarm = (I.warm || []).map((x) => +x.toFixed(3));
  const warm = row.sentinelMsWarm.length ? +(() => { const a = [...row.sentinelMsWarm].sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; })().toFixed(3) : null;
  row.sentinelMs = warm;
  if (row.sentinelMsCold == null) fail.push('sentinel did not run');
  else if (warm == null) review.push(`no warm sample (reload failed); cold ${row.sentinelMsCold} ms`);
  else if (warm >= BUDGET.sentinelMs) fail.push(`sentinel ${warm} ms warm >= ${BUDGET.sentinelMs} ms (cold ${row.sentinelMsCold} ms)`);
  // 2. exceptions and console errors
  const ourExc = I.pageErrors.filter((e) => OURS.test(e.stack) || OURS_LOOSE.test(e.stack) || /dxr-auto3d/.test(e.msg));
  row.ourExceptions = ourExc.map((e) => e.msg);
  if (ourExc.length) fail.push(`uncaught exception from our scripts: ${ourExc[0].msg}`);
  const ctrlErr = new Set([...C.errors, ...C.pageErrors.map((e) => e.msg)].map(norm));
  const newErr = [...new Set([...I.errors, ...I.pageErrors.filter((e) => !ourExc.includes(e)).map((e) => e.msg)].map(norm))].filter((e) => !ctrlErr.has(e));
  row.consoleErrorsIntroduced = newErr.slice(0, 8);
  const ourErr = newErr.filter((e) => OURS_LOOSE.test(e));
  if (ourErr.length) fail.push(`console error from our scripts: ${ourErr[0]}`);
  else if (newErr.length) review.push(`${newErr.length} console error(s) not in the control load (unattributed; re-run to rule out network noise)`);
  // 3. page-visible surface
  const protoNew = (P.protoChanges || []).filter((p) => !(Q && Q.protoChanges.includes(p)));
  row.protoDiff = protoNew;
  const protoBad = protoNew.filter((p) => !BUDGET.allowedProto.has(p) && !(webgl && /^Object\.[^ ]+ \(added\)$/.test(p)));
  if (protoBad.length) fail.push(`prototype changes beyond getContext: ${protoBad.join(', ')}`);
  const ctrlKeys = new Set(Q ? Q.newKeys : []);
  const keysNew = (P.newKeys || []).filter((k) => !ctrlKeys.has(k) && !HARNESS_KEYS.has(k));
  row.windowKeysDiff = keysNew;
  const allowed = webgl ? BUDGET.allowedKeysWebGL : BUDGET.allowedKeys;
  // Keys ending in a long number (closure_lm_182716, jQuery3510…, __jsonp_…) are per-load ids the page
  // makes itself: listed in keysNoise, not judged.
  row.keysNoise = keysNew.filter((k) => !allowed.has(k) && /\d{4,}$/.test(k));
  const keysBad = keysNew.filter((k) => !allowed.has(k) && !row.keysNoise.includes(k));
  const keysOurs = keysBad.filter((k) => /dxr|auto3d/i.test(k) || k === 'pc');
  if (keysOurs.length) fail.push(`window keys: ${keysOurs.join(', ')}`);
  else if (keysBad.length) review.push(`window keys not in the control load (likely page nondeterminism): ${keysBad.slice(0, 6).join(', ')}`);
  if (!webgl && P.pcInWindow && !(Q && Q.pcInWindow)) fail.push("'pc' in window on a page with no WebGL");
  // 4. timers, core, observers on non-WebGL pages
  row.ourTimers = { created: P.ours ? P.ours.created : null, pending: P.ours ? P.ours.pending.length : null, where: P.ours ? P.ours.where : [] };
  if (!webgl) {
    if (row.ourTimers.created) fail.push(`${row.ourTimers.created} timer(s) from our scripts on a page with no WebGL (${row.ourTimers.pending} still pending)`);
    if (row.loadCore) fail.push('core loaded on a page with no WebGL');
  }
  if (row.moMs != null && row.moMs > BUDGET.moReviewMs) review.push(`our MutationObserver spent ${row.moMs} ms`);
  // 5. page intact (coarse): its text and element count stay in the control's range
  if (Q && Q.text > 500 && P.text < 0.5 * Q.text) review.push(`page text ${P.text} chars vs ${Q.text} in control`);
  if (Q && Q.els > 200 && P.els < 0.5 * Q.els) review.push(`element count ${P.els} vs ${Q.els} in control`);
  // 6. the expectation for the group
  const live = /^converted/.test(outcome);
  if (site.group === 'plain') {
    if (engine || live) {
      const oracle = Q && Q.engineOracle.some((e) => /three|playcanvas/.test(e));
      (oracle ? review : fail).push(`${live ? 'converted' : 'engine detected'} (${engine}) on a plain page${oracle ? ' — the control load has one too: relabel the site' : ''}`);
    }
  } else if (site.group === 'sdk') {
    if (live) fail.push('an SDK page converted: the core must stand down');
  } else if (site.group === 'engine') {
    if (/converting \(never live\)|core loaded, no report/.test(outcome)) review.push(`stuck: ${outcome}`);
    if (/^flat$|^standdown$/.test(outcome)) review.push(`${outcome} without a reason`);
    if (outcome === 'offer') review.push('offer under decision allow');
    if (live && C.fps && I.fps && I.fps < 0.5 * C.fps) review.push(`fps ${I.fps} converted vs ${C.fps} control`);
  }
  if (I.nav.partial) review.push('load event did not fire in budget (judged on the partial page)');
  row.ourLogs = I.ourLogs.slice(0, 6);
  return { ...row, verdict: fail.length ? 'FAIL' : review.length ? 'REVIEW' : 'PASS', reasons: [...fail, ...review] };
}

// ------------------------------------------------------------ main
const all = JSON.parse(readFileSync(join(here, 'sites.json'), 'utf8')).sites;
const sites = all.filter((s) => (!SAMPLE || s.sample) && (!GROUP || s.group === GROUP) && (!ONLY.length || ONLY.includes(s.id)));
if (!sites.length) { console.error('no sites selected'); process.exit(2); }
if (!existsSync(CHROME)) { console.error(`FAILED: no Chrome at ${CHROME} — set CHROME=<binary>`); process.exit(2); }
const date = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const tag = date + (SAMPLE ? '-sample' : GROUP ? `-${GROUP}` : ONLY.length ? '-only' : '');
const resDir = join(here, 'results');
mkdirSync(resDir, { recursive: true });
if (KEEP) mkdirSync(join(resDir, tag), { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [`--use-angle=${ANGLE}`, '--enable-gpu', '--ignore-gpu-blocklist', '--no-sandbox', `--window-size=${W},${H}`, '--hide-scrollbars', '--force-device-scale-factor=1', '--disable-features=OpenXR,WebXR', '--mute-audio'],
});
const rows = [];
const T0 = Date.now();
const chromeVersion = await browser.version();
try {
  const gpu = await (async () => { const p = await browser.newPage(); const g = await p.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl2'); const d = gl && gl.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'n/a'; }); await p.close(); return g; })();
  console.log(`GPU: ${gpu}\nbundle: ${VENDOR.name || 'auto3d'} ${VENDOR.version} (${VENDOR.sourceCommit || '?'})\n${sites.length} site(s), concurrency 1\n`);
  for (const site of sites) {
    const t = Date.now();
    let row;
    try {
      const C = await load(browser, site, false);
      const I = await load(browser, site, true);
      row = judge(site, C, I);
      // Real pages are not deterministic (conditional polyfills, A/B scripts, ad errors). A surface or
      // console difference that is not provably ours gets ONE more control load; whatever the page
      // does on its own in either control is subtracted before the site is judged again.
      if (row.verdict !== 'PASS' && (row.reasons || []).some((r) => /prototype|window keys|console error\(s\)/.test(r))) {
        const C2 = await load(browser, site, false);
        if (C2.probe && !C2.probe.error && C.probe && !C.probe.error) {
          const u = (a, b) => [...new Set([...a, ...b])];
          C.probe.protoChanges = u(C.probe.protoChanges, C2.probe.protoChanges);
          C.probe.newKeys = u(C.probe.newKeys, C2.probe.newKeys);
          C.errors = u(C.errors, C2.errors);
          C.pageErrors = [...C.pageErrors, ...C2.pageErrors];
          row = judge(site, C, I);
          row.controlLoads = 2;
        }
      }
      if (KEEP) for (const [k, x] of [['ctrl', C], ['inj', I]]) if (x.png) writeFileSync(join(resDir, tag, `${site.id}-${k}.png`), x.png);
    } catch (e) {
      row = { id: site.id, group: site.group, url: site.url, verdict: 'ERROR', outcome: 'error', reasons: [`runner: ${String(e.message || e).slice(0, 200)}`] };
    }
    row.ms = Date.now() - t;
    rows.push(row);
    console.log(`${row.verdict.padEnd(6)} ${site.group.padEnd(6)} ${site.id.padEnd(20)} ${String(row.outcome).padEnd(28)} sentinel ${row.sentinelMs ?? '-'} ms warm / ${row.sentinelMsCold ?? '-'} cold  (${(row.ms / 1000).toFixed(0)} s)`);
    for (const r of row.reasons || []) console.log(`         ${r}`);
  }
} finally {
  await browser.close();
}

// ------------------------------------------------------------ report
const count = (v) => rows.filter((r) => r.verdict === v).length;
const n = { PASS: count('PASS'), REVIEW: count('REVIEW'), FAIL: count('FAIL'), ERROR: count('ERROR') };
const totalS = Math.round((Date.now() - T0) / 1000);
const perSite = totalS / rows.length;
const verdict = n.FAIL ? `HARM FOUND: ${n.FAIL} site(s) FAIL the §3.3 budget` : `NO HARM FOUND: ${n.PASS} PASS, ${n.REVIEW} REVIEW, ${n.ERROR} unreachable`;
const summary = { date, tag, verdict, counts: n, bundle: { version: VENDOR.version, sourceCommit: VENDOR.sourceCommit }, chrome: chromeVersion,
  totalSeconds: totalS, secondsPerSite: Math.round(perSite), estimatedFullRunMinutes: Math.round((perSite * all.length) / 60), budget: { sentinelMs: BUDGET.sentinelMs, allowedProto: [...BUDGET.allowedProto], allowedKeys: [...BUDGET.allowedKeys], allowedKeysWebGL: [...BUDGET.allowedKeysWebGL] }, rows };
writeFileSync(join(resDir, `${tag}.json`), JSON.stringify(summary, null, 2));
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|');
const md = [
  `# auto-3D no-harm corpus — ${tag}`, '',
  `**${verdict}.**`, '',
  `Bundle ${VENDOR.version} (${VENDOR.sourceCommit || '?'}), ${summary.chrome || 'Chrome'}, ${rows.length} site(s) in ${totalS} s (${Math.round(perSite)} s/site; full ${all.length}-site run ≈ ${summary.estimatedFullRunMinutes} min).`, '',
  '| verdict | group | site | outcome | engine | loadCore | sentinel ms warm (cold) | WebGL ctx | surface diff (keys / protos) | our timers | new console errors | notes |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.verdict} | ${r.group} | [${r.id}](${r.url}) | ${esc(r.outcome)} | ${esc(r.engine || '')} | ${r.loadCore ?? ''} | ${r.sentinelMs ?? ''} (${r.sentinelMsCold ?? ''}) | ${r.webglContexts ?? ''} | ${esc((r.windowKeysDiff || []).join(', ') || '—')} / ${esc((r.protoDiff || []).join(', ') || '—')} | ${r.ourTimers ? `${r.ourTimers.created} (${r.ourTimers.pending} pending)` : ''} | ${(r.consoleErrorsIntroduced || []).length} | ${esc((r.reasons || []).join('; '))} |`),
  '', 'Budget (design §3.3): sentinel < 0.5 ms warm (median of three reloads; the cold first load is shown in brackets); no prototype change beyond `HTMLCanvasElement.prototype.getContext`; on pages without WebGL no timers, no core, and nothing on `window` except `__THREE_DEVTOOLS__`. See README.md.', '',
].join('\n');
writeFileSync(join(resDir, `${tag}.md`), md);
console.log(`\n${verdict}\n${totalS} s total, ~${Math.round(perSite)} s/site → full ${all.length}-site run ≈ ${summary.estimatedFullRunMinutes} min\nwrote results/${tag}.json + .md`);
process.exit(n.FAIL ? 1 : 0);

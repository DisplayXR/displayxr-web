// inline3d-check — orchestration: load the page twice in headless Chrome (once with the fake
// DisplayXR inline-3D environment, once plain), collect evidence, and turn it into checks.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, relative, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, withTimeout } from './cdp.mjs';
import { serveDir } from './server.mjs';
import { decodePng } from './png.mjs';
import {
  crop, halves, contentStats, regionDiff, compareEyes, blockDisparity, quantile, flatWideVerdict, sbsPairVerdict, shibataZoneMm, fromBase64Rgba,
} from './analyze.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE_SRC = readFileSync(join(HERE, 'probe.js'), 'utf8');
const FAKE_SRC = readFileSync(join(HERE, 'fake-env.js'), 'utf8');
export const VERSION = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DOCS = 'node_modules/@displayxr/inline3d/docs';
const MPP = 0.3456 / 1920; // metres per CSS px on the fake panel (see fake-env.js)

// ------------------------------------------------------------------------------ target
export async function resolveTarget(target, rootOpt) {
  if (/^https?:\/\//i.test(target)) return { url: target, server: null, kind: 'url' };
  // A local target may carry a query/hash for the page (`page.html?debug`).
  const qi = target.search(/[?#]/);
  const suffix = qi >= 0 ? target.slice(qi) : '';
  if (qi >= 0) target = target.slice(0, qi);
  const abs = resolve(target);
  if (!existsSync(abs)) throw new Error(`target not found: ${target}`);
  const isDir = statSync(abs).isDirectory();
  const root = resolve(rootOpt || (isDir ? abs : dirname(abs)));
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`target ${abs} is outside --root ${root}`);
  const server = await serveDir(root);
  let rel = relative(root, abs).split(sep).join('/');
  if (isDir && rel && !rel.endsWith('/')) rel += '/';
  return { url: `${server.url}/${rel}${suffix}`, server, kind: isDir ? 'dir' : 'file', root, file: abs };
}

// ------------------------------------------------------------------------------ page plumbing
async function ev(page, expression) {
  const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page evaluate failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
}

function collect(page, pageOrigin) {
  const log = { console: [], exceptions: [], network: [], logEntries: [], scripts: [] };
  page.on('Runtime.consoleAPICalled', (p) => {
    const text = (p.args || []).map((a) => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : a.description || a.type)).join(' ');
    const fr = p.stackTrace && p.stackTrace.callFrames && p.stackTrace.callFrames[0];
    log.console.push({ type: p.type, text: text.slice(0, 600), at: fr ? `${fr.url}:${fr.lineNumber + 1}` : undefined });
  });
  page.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    log.exceptions.push({ text: ((d.exception && d.exception.description) || d.text || 'exception').slice(0, 600), at: d.url ? `${d.url}:${(d.lineNumber || 0) + 1}` : undefined });
  });
  page.on('Log.entryAdded', (p) => {
    const e = p.entry || {};
    log.logEntries.push({ level: e.level, source: e.source, text: (e.text || '').slice(0, 400), url: e.url });
  });
  const reqs = new Map();
  page.on('Network.responseReceived', (p) => {
    const u = p.response.url;
    reqs.set(p.requestId, { url: u, type: p.type, status: p.response.status });
    if (p.response.status >= 400) log.network.push({ url: u, status: p.response.status, type: p.type });
  });
  page.on('Network.loadingFailed', (p) => {
    if (p.canceled || /ERR_ABORTED/.test(p.errorText || '')) return;
    const r = reqs.get(p.requestId);
    log.network.push({ url: r ? r.url : `request ${p.requestId}`, error: p.errorText, type: p.type });
  });
  page.on('Network.loadingFinished', (p) => {
    const r = reqs.get(p.requestId);
    if (!r || !pageOrigin) return;
    if (!['Document', 'Script'].includes(r.type)) return;
    let u;
    try { u = new URL(r.url); } catch { return; }
    if (u.origin !== pageOrigin) return;
    if (/\/node_modules\/|\/js\/inline3d[^/]*\.js$|@displayxr|\/vendor\/|\/dist\/|\/\.vite\/deps\//.test(u.pathname)) return;
    log.scripts.push({ requestId: p.requestId, url: r.url, type: r.type });
  });
  return log;
}

async function preparePage(conn, { fake, cfg, viewport }) {
  const page = await conn.newPage();
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Network.enable');
  await page.send('Network.setCacheDisabled', { cacheDisabled: false });
  await page.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.dpr, mobile: false });
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  const src = `window.__DXR_CHECK_CFG = ${JSON.stringify(cfg)};\n${PROBE_SRC}\n${fake ? FAKE_SRC : ''}`;
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: src });
  return page;
}

async function navigate(page, url, timeoutMs) {
  const loaded = new Promise((r) => page.on('Page.loadEventFired', () => r(true)));
  const nav = await page.send('Page.navigate', { url });
  if (nav.errorText) throw new Error(`navigation failed: ${nav.errorText}`);
  return withTimeout(loaded, timeoutMs, 'page load event').catch(() => false);
}

async function screenshot(page) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  return decodePng(Buffer.from(data, 'base64'));
}

async function staticScan(page, log) {
  const findings = { isSessionSupported: [], uaSniff: [], importMaps: [] };
  for (const s of log.scripts.slice(0, 40)) {
    let body = '';
    try {
      const r = await page.send('Network.getResponseBody', { requestId: s.requestId });
      body = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
    } catch { continue; }
    if (body.length > 3_000_000) continue;
    if (/isSessionSupported\s*\(\s*['"`]inline-3d/.test(body)) findings.isSessionSupported.push(s.url);
    if (/navigator\.(userAgent|userAgentData)/.test(body) && /displayxr/i.test(body)) findings.uaSniff.push(s.url);
    if (s.type === 'Document') {
      const re = /<script[^>]*type\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi;
      let m;
      while ((m = re.exec(body))) {
        try { findings.importMaps.push({ url: s.url, imports: JSON.parse(m[1]).imports || {} }); } catch { findings.importMaps.push({ url: s.url, error: 'invalid JSON' }); }
      }
    }
  }
  return findings;
}

// ------------------------------------------------------------------------------ the fake run
async function fakeRun(conn, url, opt, origin) {
  const page = await preparePage(conn, { fake: true, cfg: { maxTextureSize: opt.maxTexture || 0 }, viewport: opt.viewport });
  const log = collect(page, origin);
  const t0 = Date.now();
  const loaded = await navigate(page, url, opt.loadTimeoutMs);
  const deadline = Date.now() + opt.timeoutMs;
  let summary = null, scrolled = 0;
  const cssSeen = new Map(); // layer index -> union of problems over time
  let readySince = 0;
  while (Date.now() < deadline) {
    await sleep(250);
    summary = await ev(page, '__dxrCheck.summary()').catch(() => summary);
    if (!summary) continue;
    const open = summary.layers.filter((l) => l.open);
    const sinceLoad = Date.now() - t0;
    if (!summary.sessionRequests.length && sinceLoad > opt.noSessionGiveUpMs) break;
    if (summary.sessionRequests.length && !open.length && sinceLoad > 3000 && scrolled < 6) {
      // Lazy windows activate when they intersect the viewport: scroll the page to find them.
      scrolled++;
      await ev(page, `window.scrollBy(0, Math.round(innerHeight * 0.8)), window.scrollY`);
      continue;
    }
    if (!open.length) continue;
    for (const l of open.slice(0, 4)) {
      const a = await ev(page, `__dxrProbe.cssAudit(__dxrCheck.layerCanvas(${l.index}))`).catch(() => null);
      if (!a) continue;
      const cur = cssSeen.get(l.index) || { problems: new Map(), decorations: new Set(), animations: new Map() };
      for (const p of a.problems) cur.problems.set(`${p.element}|${p.prop}`, p);
      for (const d of a.decorations) cur.decorations.add(d);
      for (const an of a.animations) cur.animations.set(`${an.element}|${an.props}`, an);
      cssSeen.set(l.index, cur);
    }
    const youngest = Math.min(...open.map((l) => l.ageMs));
    if (youngest < opt.settleMs) continue;
    // Ready when every open layer's canvas holds something in both halves (content loaded).
    let allDrawn = true;
    for (const l of open.slice(0, 4)) {
      const s = await ev(page, `__dxrCheck.snap(${l.index}, 128)`).catch(() => null);
      if (!s || !s.sw) { allDrawn = false; break; }
      const [L, R] = halves(fromBase64Rgba(s.rgba, s.sw, s.sh));
      if (contentStats(L).blank || contentStats(R).blank) { allDrawn = false; break; }
    }
    if (allDrawn) {
      if (!readySince) readySince = Date.now();
      if (Date.now() - readySince >= 400) break;
    } else readySince = 0;
  }
  summary = await ev(page, '__dxrCheck.summary()').catch(() => summary);
  const layers = [];
  for (const l of (summary ? summary.layers : []).filter((x) => x.open).slice(0, 4)) {
    const snap = await ev(page, `__dxrCheck.snap(${l.index}, 640)`).catch((e) => ({ error: String(e) }));
    const buffer = await ev(page, `__dxrProbe.bufferInfo(__dxrCheck.layerCanvas(${l.index}))`).catch(() => null);
    const occlusion = await ev(page, `__dxrProbe.occlusionAudit(__dxrCheck.layerCanvas(${l.index}))`).catch(() => null);
    const css = await ev(page, `__dxrProbe.cssAudit(__dxrCheck.layerCanvas(${l.index}))`).catch(() => null);
    const seen = cssSeen.get(l.index);
    if (css && seen) {
      for (const p of css.problems) seen.problems.set(`${p.element}|${p.prop}`, p);
      for (const d of css.decorations) seen.decorations.add(d);
      for (const an of css.animations) seen.animations.set(`${an.element}|${an.props}`, an);
    }
    const cssAll = seen
      ? { problems: [...seen.problems.values()], decorations: [...seen.decorations], animations: [...seen.animations.values()] }
      : css || { problems: [], decorations: [], animations: [] };
    layers.push({ ...l, snap, buffer, occlusion, css: cssAll });
  }
  const shaderErrors = await ev(page, '__dxrProbe.shaderErrors').catch(() => []);
  const scrollY = await ev(page, 'window.scrollY').catch(() => 0);
  const media = await ev(page, `__dxrProbe.mediaElements(__dxrCheck.layers.filter(r => !r.layer.closed).map(r => r.canvas))`).catch(() => []);
  let shot = null;
  try { shot = await screenshot(page); } catch { /* none */ }
  const statics = await staticScan(page, log);
  const scroll = opt.noScroll ? null : await scrollSweep(page, layers).catch((e) => ({ error: String(e) }));
  const loss = opt.noLoss ? null : await layerLossProbe(page, layers).catch((e) => ({ error: String(e) }));
  await page.close();
  return { loaded, summary, layers, log, shaderErrors, media, shot, scrollY, scrolled, statics, scroll, loss, ms: Date.now() - t0 };
}

// Scroll the whole page past each woven canvas and audit what sits over it at every step: a
// sticky header that only reaches the tile once the page scrolls is invisible to the end-of-run
// audit. Restores the scroll position.
async function scrollSweep(page, layers) {
  if (!layers.length) return { steps: 0, layers: [] };
  const y0 = await ev(page, 'window.scrollY');
  const max = await ev(page, 'Math.max(0, document.documentElement.scrollHeight - innerHeight)');
  const vh = await ev(page, 'innerHeight');
  const step = Math.max(40, Math.round(vh * 0.25));
  const ys = [];
  for (let y = 0; y <= max && ys.length < 16; y += step) ys.push(y);
  if (max > 0 && ys[ys.length - 1] !== max) ys.push(max);
  const per = layers.map((l) => ({ selector: l.selector, maxCovered: 0, maxCoveredAt: null, maxFrost: 0, coverers: new Map(), effects: new Map(), samples: 0 }));
  for (const y of ys) {
    await ev(page, `window.scrollTo(0, ${y})`);
    await sleep(60);
    for (let i = 0; i < layers.length; i++) {
      const a = await ev(page, `__dxrProbe.occlusionAudit(__dxrCheck.layerCanvas(${layers[i].index}), 7, 5)`).catch(() => null);
      if (!a || !a.visible || !a.total || a.total < 0.5 * 35) continue; // mostly off screen: not judged here
      const r = per[i];
      r.samples++;
      if (a.coveredFraction > r.maxCovered) { r.maxCovered = a.coveredFraction; r.maxCoveredAt = y; }
      if (a.frostFraction > r.maxFrost) { r.maxFrost = a.frostFraction; r.maxFrostAt = y; }
      for (const c of a.coverers) r.coverers.set(c.selector, Math.max(r.coverers.get(c.selector) || 0, c.hits));
      for (const e of a.effects || []) r.effects.set(e.selector, e.props);
    }
  }
  await ev(page, `window.scrollTo(0, ${y0})`);
  await sleep(100);
  return {
    steps: ys.length,
    layers: per.map((r) => ({ ...r, coverers: [...r.coverers.keys()], effects: [...r.effects.entries()].map(([selector, props]) => ({ selector, props })) })),
  };
}

// End the inline-3D session (as the browser does when the weave goes away) and look at what each
// woven canvas shows a second later: an addScene page whose onLayerLost does nothing is left
// showing its last side-by-side pair, unwoven.
async function layerLossProbe(page, layers) {
  if (!layers.length) return null;
  // Before: each canvas in view, as the woven run left it (its side-by-side pair).
  const rectOf = (i) => ev(page, `(() => { const c = __dxrCheck.layerCanvas(${i}); if (!c) return null; c.scrollIntoView({ block: 'center', inline: 'center' }); const cs = getComputedStyle(c); const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height, shown: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0 }; })()`).catch(() => null);
  const grab = async (rect) => { try { const shot = await screenshot(page); return regionOf(shot, rect); } catch { return null; } };
  const before = [];
  for (const l of layers.slice(0, 4)) {
    const rect = await rectOf(l.index);
    await sleep(150);
    before.push(rect && rect.shown ? { rect, reg: await grab(rect) } : null);
  }
  const n = await ev(page, '__dxrCheck.endSessions()');
  if (!n) return { ended: 0, layers: [] };
  await sleep(1200);
  const out = [];
  for (let i = 0; i < before.length; i++) {
    const l = layers[i], b = before[i];
    if (!b || !b.reg) { out.push({ selector: l.selector, shown: !!b, measured: false }); continue; }
    const rect = await rectOf(l.index);
    if (!rect || !rect.shown) { out.push({ selector: l.selector, shown: false }); continue; }
    await sleep(250);
    const reg = await grab(rect);
    if (!reg) { out.push({ selector: l.selector, shown: true, measured: false }); continue; }
    const diff = regionDiff(b.reg, reg);
    const st = contentStats(reg);
    // Unchanged since the woven run = still the side-by-side pair (nothing went flat). A mono view
    // (one picture across the canvas) or a 2D fallback differs from it by far more than this.
    const frozen = diff < 2.5 && !contentStats(b.reg).blank;
    out.push({ selector: l.selector, shown: true, measured: true, sbs: frozen || sbsPairVerdict(reg).sbs, frozen, diff: +diff.toFixed(2), blank: st.blank });
  }
  return { ended: n, layers: out };
}

// ------------------------------------------------------------------------------ the plain run
async function plainRun(conn, url, opt, fake, origin) {
  const page = await preparePage(conn, { fake: false, cfg: {}, viewport: opt.viewport });
  const log = collect(page, origin);
  const t0 = Date.now();
  const loaded = await navigate(page, url, opt.loadTimeoutMs);
  const selectors = fake.layers.map((l) => l.selector);
  // Judge each canvas that wove in the 3D run IN VIEW (a lazy page only renders what is on
  // screen), waiting until it shows something or the budget runs out.
  const deadline = Date.now() + opt.plainTimeoutMs;
  const regions = [];
  let shot = null;
  await sleep(600);
  const measure = (s) => ev(page, `(() => { const el = document.querySelector(${JSON.stringify(s)}); if (!el) return { selector: ${JSON.stringify(s)}, missing: true }; const cs = getComputedStyle(el); let r = el.getBoundingClientRect(); if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) { el.scrollIntoView({ block: 'center', inline: 'center' }); r = el.getBoundingClientRect(); } return { selector: ${JSON.stringify(s)}, rect: { x: r.left, y: r.top, width: r.width, height: r.height }, visible: cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0 && r.width > 0 && r.height > 0 }; })()`).catch(() => ({ selector: s, missing: true }));
  for (const s of selectors) {
    let m = await measure(s);
    while (!m.missing && m.visible) {
      try { shot = await screenshot(page); } catch { shot = null; break; }
      m.stats = regionStats(shot, m.rect);
      const reg = regionOf(shot, m.rect);
      m.sbs = reg ? sbsPairVerdict(reg).sbs : false;
      if (!m.stats.blank || Date.now() > deadline) break;
      await sleep(400);
      m = { ...(await measure(s)) };
    }
    regions.push(m);
  }
  if (!selectors.length) await sleep(1500);
  if (fake.scrollY !== undefined) await ev(page, `window.scrollTo(0, ${fake.scrollY || 0})`).catch(() => {});
  await sleep(150);
  try { shot = await screenshot(page); } catch { /* keep */ }
  const media = await ev(page, `__dxrProbe.mediaElements([])`).catch(() => []);
  const shaderErrors = await ev(page, '__dxrProbe.shaderErrors').catch(() => []);
  const sessionAttempt = await ev(page, `!!navigator.xr`).catch(() => null);
  await page.close();
  return { loaded, regions, media, shot, log, shaderErrors, hasXR: sessionAttempt, ms: Date.now() - t0 };
}

function regionOf(shot, rect) {
  const x = Math.max(0, rect.x), y = Math.max(0, rect.y);
  const w = Math.min(shot.width, rect.x + rect.width) - x, h = Math.min(shot.height, rect.y + rect.height) - y;
  if (w < 4 || h < 4) return null;
  return crop(shot, x, y, w, h);
}
function regionStats(shot, rect) {
  const r = rect && regionOf(shot, rect);
  return r ? contentStats(r) : { blank: true, contentFraction: 0 };
}

// ------------------------------------------------------------------------------ log classification
const GL_RE = /GL_INVALID|WebGL: INVALID|WebGL: CONTEXT_LOST|WebGL: too many errors|GL ERROR|Shader Error|Failed to compile|could not compile|ERROR: 0:\d+|program not valid|WebGLProgram|link failed/i;
function classify(log, shaderErrors) {
  const ignoreUrl = (u) => /favicon\.ico/.test(u || '');
  const errors = [], gl = [], warnings = [], sdkWarnings = [];
  for (const c of log.console) {
    if (GL_RE.test(c.text)) { gl.push(c.text); continue; }
    if (c.type === 'error' || c.type === 'assert') errors.push(`console.error: ${c.text}`);
    else if (c.type === 'warning') {
      if (/^\[inline3d\]/.test(c.text)) sdkWarnings.push(c.text);
      else warnings.push(c.text);
    }
  }
  for (const e of log.exceptions) errors.push(`uncaught: ${e.text}${e.at ? ` (${e.at})` : ''}`);
  for (const e of log.logEntries) {
    if (GL_RE.test(e.text)) { gl.push(e.text); continue; }
    if (e.level === 'error' && !ignoreUrl(e.url) && e.source !== 'network') errors.push(`${e.source}: ${e.text}`);
  }
  for (const n of log.network) {
    if (ignoreUrl(n.url)) continue;
    errors.push(n.status ? `HTTP ${n.status} ${n.url}` : `request failed (${n.error}) ${n.url}`);
  }
  for (const s of shaderErrors || []) gl.push(s);
  return { errors: dedupe(errors), gl: dedupe(gl), warnings: dedupe(warnings), sdkWarnings: dedupe(sdkWarnings) };
}
const dedupe = (a) => [...new Set(a)].slice(0, 25);

// ------------------------------------------------------------------------------ checks
function check(id, letter, title, status, summary, extra = {}) {
  return { id, letter, title, status, summary, ...extra };
}

function buildChecks(fake, plain, opt) {
  const checks = [];
  const S = fake.summary || { sessionRequests: [], layers: [], maxLiveSessions: 0, framesWithViews: 0, isSessionSupportedCalls: [], activeModeIndex: 1 };
  const okSessions = S.sessionRequests.filter((r) => r.ok && r.mode === 'inline-3d');
  const open = fake.layers;
  const primary = open[0] || null;

  // per-layer pixel analysis
  for (const l of open) {
    const s = l.snap;
    if (!s || !s.sw || s.error) { l.px = null; continue; }
    const buf = fromBase64Rgba(s.rgba, s.sw, s.sh);
    const [L, R] = halves(buf);
    const statsL = contentStats(L), statsR = contentStats(R);
    const fw = flatWideVerdict(buf);
    const blocks = !statsL.blank && !statsR.blank && !fw.cmp.identical ? blockDisparity(L, R) : [];
    l.px = { statsL, statsR, cmp: fw.cmp, flatWide: fw.flatWide, sameScene: fw.sameScene, seam: fw.seam, matchRatio: fw.matchRatio, blocks, eyeW: L.width };
  }

  // (a) session
  {
    let status = 'pass', summary;
    if (!okSessions.length) {
      status = 'fail';
      summary = S.sessionRequests.length
        ? `requested ${S.sessionRequests.map((r) => r.mode).join(', ')}, never 'inline-3d'`
        : 'the page never requested an inline-3d session (createInline3D() was not called, or ran after an error)';
    } else if (!open.length) {
      status = 'fail';
      summary = S.layers.length
        ? 'a layer was created but none was still open at the end (closed, removed, or the session ended)'
        : 'a session started but no canvas was registered (no addImage/addVideo/addScene/addModel/addSplat/addPlayer, or a lazy tile that never entered the viewport)';
    } else if (!primary.px) {
      status = 'fail';
      summary = 'could not read the woven canvas back';
    } else if (primary.px.statsL.blank && primary.px.statsR.blank) {
      status = 'fail';
      summary = `session + ${open.length} layer(s), ${S.framesWithViews} frames with views, but the canvas stayed empty`;
    } else {
      summary = `inline-3d session, ${open.length} open layer(s) (${open.map((l) => l.selector).join(', ')}), ${S.framesWithViews} frames with two views`;
    }
    checks.push(check('session', 'a', 'Reached a 3D session and drew into the woven canvas', status, summary, {
      details: { sessions: S.sessionRequests, layers: S.layers.map((l) => ({ selector: l.selector, open: l.open, ageMs: Math.round(l.ageMs) })), scrolledToFind: fake.scrolled },
      hint: status === 'fail' ? 'Detect with createInline3D() and branch on wall.supported; register the canvas with one add*() call. A lazy tile (the default) only gets a layer once it is on screen.' : undefined,
      doc: `${DOCS}/authoring-inline-3d.md`,
    }));
  }

  // (b) stereo
  {
    let status = 'skip', summary = 'no woven canvas to inspect';
    const details = [];
    const flatRequested = S.activeModeIndex === 0 || (primary && primary.rig && primary.rig.ipdFactor === 0);
    for (const l of open) {
      if (!l.px) continue;
      const { cmp, blocks, sameScene } = l.px;
      const ds = blocks.map((b) => b.d);
      const range = ds.length >= 3 ? quantile(ds, 0.95) - quantile(ds, 0.05) : 0;
      details.push({ selector: l.selector, identical: cmp.identical, differingFraction: +cmp.differingFraction.toFixed(4), bestShiftPx: cmp.bestShift, madBest: +cmp.madBest.toFixed(2), baseline: +cmp.baseline.toFixed(2), disparityRangePx: +range.toFixed(2), blocks: blocks.length, blockMatchRatio: +l.px.matchRatio.toFixed(2), seamRatio: +l.px.seam.ratio.toFixed(2), sameScene });
    }
    const d0 = details[0];
    if (d0) {
      if (flatRequested) { status = 'warn'; summary = 'the page switched the display to 2D (setStereoEnabled(false) / a zero-ipd rig): eyes are expected to match'; }
      else if (open[0].px.statsL.blank || open[0].px.statsR.blank) { status = 'skip'; summary = 'an eye is blank (see eyes-not-blank)'; }
      else if (d0.identical) { status = 'fail'; summary = 'left and right eyes are the SAME picture: a duplicated flat image, not stereo'; }
      else if (!d0.sameScene) { status = 'fail'; summary = 'the two halves are not two views of one scene (see no-flat-sbs)'; }
      else if (d0.blocks >= 3 && d0.disparityRangePx < 0.25) { status = 'warn'; summary = `eyes differ only by a uniform shift (${d0.bestShiftPx}px): the content is flat, at a single depth`; }
      else { status = 'pass'; summary = `eyes differ (${(d0.differingFraction * 100).toFixed(1)}% of pixels), disparity range ${d0.disparityRangePx}px across ${d0.blocks} matched blocks`; }
    }
    checks.push(check('stereo', 'b', 'Left and right eyes differ (real stereo)', status, summary, {
      details,
      hint: status === 'fail' ? 'Render each view with its own projectionMatrix and transform.matrix into layer.getViewport(view) (EyeCamera.setFromView in ./three). Never draw one mono camera into both halves.' : undefined,
      doc: `${DOCS}/authoring-inline-3d.md#3-live-scene-threejs--webgl--addscenecanvas-onframe-opts`,
    }));
  }

  // (c) eyes not blank
  {
    let status = 'skip', summary = 'no woven canvas to inspect';
    const details = [];
    for (const l of open) {
      if (!l.px) continue;
      const f = (st) => ({ blank: st.blank, black: !!st.black, transparent: !!st.transparent, contentPct: +(st.contentFraction * 100).toFixed(2), meanLum: +st.meanLum.toFixed(1) });
      details.push({ selector: l.selector, left: f(l.px.statsL), right: f(l.px.statsR) });
    }
    if (details.length) {
      const bad = details.filter((d) => d.left.blank || d.right.blank);
      status = bad.length ? 'fail' : 'pass';
      summary = bad.length
        ? bad.map((d) => `${d.selector}: ${d.left.blank ? `left eye ${d.left.black ? 'black' : d.left.transparent ? 'empty/transparent' : 'flat-filled'}` : ''}${d.left.blank && d.right.blank ? ', ' : ''}${d.right.blank ? `right eye ${d.right.black ? 'black' : d.right.transparent ? 'empty/transparent' : 'flat-filled'}` : ''}`).join('; ')
        : `both eyes hold content in ${details.length} canvas(es)`;
    }
    checks.push(check('eyes-not-blank', 'c', 'Neither eye is black or blank', status, summary, {
      details,
      hint: status === 'fail' ? 'Validate before you clear: skip the clear when views.length < 2 or a viewport is null, and repaint the last good frame. Check the asset loaded, the camera faces the subject, and that pixelRatio is 1 when you use getViewport().' : undefined,
      doc: `${DOCS}/authoring-inline-3d.md`,
    }));
  }

  // (d) no raw side-by-side shown flat, no full-width flat picture in a woven canvas
  {
    const fails = [], warns = [];
    for (const l of open) {
      if (l.px && l.px.flatWide) fails.push(`${l.selector}: one full-width flat picture is drawn into the woven canvas (the halves run on across the middle), so each eye sees a different half`);
      if (l.joinSamples >= 3 && l.joinExposed / l.joinSamples > 0.3) warns.push(`${l.selector}: uncovered and holding pixels during the join window (${l.joinExposed}/${l.joinSamples} samples in the first 1.2 s): the browser may flash the raw side-by-side pair. Cover it until handle.firstWoven.`);
    }
    if (fake.shot) {
      for (const m of fake.media) {
        const r = regionOf(fake.shot, m.rect);
        if (r && sbsPairVerdict(r).sbs) fails.push(`${m.selector} (${m.tag}, not woven) shows a raw side-by-side pair flat in the 3D run`);
      }
    }
    if (plain && plain.shot) {
      const seen = new Set();
      for (const r of plain.regions || []) {
        if (r.missing || !r.visible) continue;
        if (r.sbs) { fails.push(`${r.selector} shows a raw side-by-side pair flat in the plain (2D) browser`); seen.add(r.selector); }
      }
      for (const m of plain.media) {
        if (seen.has(m.selector)) continue;
        const reg = regionOf(plain.shot, m.rect);
        if (reg && sbsPairVerdict(reg).sbs) fails.push(`${m.selector} (${m.tag}) shows a raw side-by-side pair flat in the plain (2D) browser`);
      }
    }
    const status = fails.length ? 'fail' : warns.length ? 'warn' : open.length || (plain && plain.shot) ? 'pass' : 'skip';
    checks.push(check('no-flat-sbs', 'd', 'No raw side-by-side shown flat; no full-width flat image in a woven canvas', status,
      fails[0] || warns[0] || 'no flat side-by-side pair and no full-width picture in a woven canvas', {
        details: { fails, warns },
        hint: fails.length ? 'In 2D, show ONE eye (the left half) or a mono render, never the packed pair. In 3D, draw a flat picture into each eye viewport (or call setStereoEnabled(false)), never across the whole canvas.' : warns.length ? 'Stack an opaque cover over the canvas and remove it (hard cut) on await handle.firstWoven, plus a timeout and a catch so it always comes off.' : undefined,
        doc: `${DOCS}/woven-canvas-rules.md`,
      }));
  }

  // (e) buffer not clamped
  {
    const fails = [], warns = [], details = [];
    for (const l of open) {
      const b = l.buffer;
      if (!b) continue;
      const limit = opt.maxTexture || b.maxTextureSize || 16384;
      details.push({ selector: l.selector, ...b, limit });
      if (b.drawingBufferWidth != null && (b.drawingBufferWidth < b.width || b.drawingBufferHeight < b.height)) {
        fails.push(`${l.selector}: canvas is ${b.width}x${b.height} but the drawing buffer is ${b.drawingBufferWidth}x${b.drawingBufferHeight}: the browser clamped it, and getViewport() (which splits canvas.width) puts the eye boundary off-centre`);
      } else if (Math.max(b.width, b.height) > limit) {
        fails.push(`${l.selector}: canvas ${b.width}x${b.height} exceeds the ${limit} texture limit`);
      } else if (!opt.maxTexture && Math.max(b.width, b.height) > 4096) {
        warns.push(`${l.selector}: canvas ${b.width}x${b.height} would be clamped on a tablet with MAX_TEXTURE_SIZE 4096 (rerun with --max-texture 4096)`);
      }
    }
    const status = fails.length ? 'fail' : warns.length ? 'warn' : details.length ? 'pass' : 'skip';
    checks.push(check('buffer', 'e', `Drawing buffer not clamped${opt.maxTexture ? ` (simulated MAX_TEXTURE_SIZE ${opt.maxTexture})` : ''}`, status,
      fails[0] || warns[0] || (details.length ? details.map((d) => `${d.selector} ${d.width}x${d.height}${d.drawingBufferWidth != null ? ` (buffer ${d.drawingBufferWidth}x${d.drawingBufferHeight})` : ''}`).join('; ') : 'no woven canvas'), {
        details,
        hint: fails.length || warns.length ? 'Cap devicePixelRatio at 2, keep width = 2 x eye width and both sides within min(MAX_TEXTURE_SIZE, MAX_RENDERBUFFER_SIZE, MAX_VIEWPORT_DIMS), and draw into gl.drawingBufferWidth/Height. ./viewer, ./model, ./splat, addImage and addVideo clamp for you.' : undefined,
        doc: `${DOCS}/woven-canvas-rules.md#5-pitfalls-from-production-september-2026`,
      }));
  }

  // (f1) CSS on the woven canvas and its ancestors
  {
    const problems = [], decorations = [], animations = [];
    for (const l of open) {
      for (const p of l.css.problems) problems.push(`${l.selector}: ${p.text}`);
      for (const d of l.css.decorations) decorations.push(`${l.selector}: ${d} on the canvas`);
      for (const a of l.css.animations) animations.push(`${l.selector}: ${a.element} animates ${a.props.join(', ')}`);
    }
    const status = problems.length ? 'fail' : decorations.length || animations.length ? 'warn' : open.length ? 'pass' : 'skip';
    checks.push(check('css', 'f', 'No CSS transform/filter/opacity/mask/blend on the woven canvas or its ancestors', status,
      problems[0] || decorations[0] || animations[0] || 'no render-surface CSS on the canvas or its ancestors', {
        details: { problems: dedupe(problems), decorations: dedupe(decorations), animations: dedupe(animations) },
        hint: status !== 'pass' && status !== 'skip' ? 'Remove filter, opacity < 1, mask, clip-path, mix-blend-mode, backdrop-filter and non-translate transforms from the canvas and every ancestor; do rounded corners with cornerRadius, soft edges with feather, everything else inside the canvas per eye. Don\'t animate the tile\'s box.' : undefined,
        doc: `${DOCS}/woven-canvas-rules.md#7-no-css-effects-on-a-woven-canvas-or-on-any-of-its-ancestors`,
      }));
  }

  // (f2) one session; no double registration; no overlapping woven canvases
  {
    const fails = [], warns = [];
    if (S.maxLiveSessions > 1) fails.push(`${S.maxLiveSessions} inline-3d sessions were live at once: call createInline3D() once per document (the managers overwrite each other's rect list every frame)`);
    else if (okSessions.length > 1) warns.push(`${okSessions.length} sessions were created one after another (close() the old one first, or keep one manager for the document)`);
    for (const l of S.layers) if (l.sameCanvasLiveAtCreate > 0) warns.push(`${l.selector} was registered again while its first layer was live (add*() on the same canvas is not a content swap: remove() first)`);
    for (let i = 0; i < open.length; i++) for (let j = i + 1; j < open.length; j++) {
      const a = open[i].occlusion && open[i].occlusion.rect, b = open[j].occlusion && open[j].occlusion.rect;
      if (!a || !b || !open[i].occlusion.visible || !open[j].occlusion.visible) continue;
      const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
      const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      if (ix * iy > 0.02 * Math.min(a.width * a.height, b.width * b.height)) fails.push(`woven canvases ${open[i].selector} and ${open[j].selector} overlap: hide the one underneath (display:none) while the other shows`);
    }
    const status = fails.length ? 'fail' : warns.length ? 'warn' : okSessions.length ? 'pass' : 'skip';
    checks.push(check('single-session', 'f', 'One createInline3D session; no double registration or overlapping woven canvases', status,
      fails[0] || warns[0] || `${okSessions.length} session, ${S.layers.length} layer(s)`, {
        details: { sessions: okSessions.length, maxLive: S.maxLiveSessions, fails, warns },
        doc: `${DOCS}/woven-canvas-rules.md#1-one-inline-3d-session-per-document`,
      }));
  }

  // (f3) opaque element over the canvas / a cover that never comes off
  {
    const fails = [], warns = [], details = [];
    for (const l of open) {
      const o = l.occlusion;
      if (!o) continue;
      details.push({ selector: l.selector, visible: o.visible, coveredPct: Math.round(o.coveredFraction * 100), frostPct: Math.round(o.frostFraction * 100), coverers: o.coverers.slice(0, 3), coveredAtCreatePct: l.coverAtCreate && l.coverAtCreate.total ? Math.round(l.coverAtCreate.coveredFraction * 100) : null });
      if (!o.visible) { fails.push(`${l.selector} is not visible at the end of the run (display:none, visibility:hidden or zero size)`); continue; }
      if (!o.total) continue; // off screen
      const top = o.coverers[0] && o.coverers[0].selector;
      const createTop = l.coverAtCreate && l.coverAtCreate.coverers && l.coverAtCreate.coverers[0] && l.coverAtCreate.coverers[0].selector;
      if (o.coveredFraction >= 0.5) {
        if (createTop && createTop === top) fails.push(`${l.selector}: the cover ${top} that was over the canvas when it was registered is still there ${Math.round(l.ageMs / 100) / 10}s later (it never came off: remove it on handle.firstWoven, plus a timeout and a catch)`);
        else fails.push(`${l.selector}: ${Math.round(o.coveredFraction * 100)}% of the canvas is under an opaque element (${top}): nothing with a background may sit above a woven canvas; put backdrops under it`);
      }
      // Partial chrome over a tile (a sticky header, a buy card, a caption) is fine on a
      // draw-order browser, opaque or translucent: it occludes that part as 2D. Not judged.
      if (o.frostFraction >= 0.9) warns.push(`${l.selector}: a backdrop-filter covers the whole tile, so the whole tile goes mono; frost only a partial region`);
    }
    // The scroll sweep: what sits over each tile at ANY scroll position (sticky chrome reaches a
    // tile only once the page scrolls).
    const sweep = fake.scroll && fake.scroll.layers ? fake.scroll.layers : [];
    for (const r of sweep) {
      for (const e of r.effects) warns.push(`${r.selector}: ${e.selector} passes over the tile while scrolling with ${e.props}: a pixel-moving filter, blend mode or 3D context cannot be lifted over the weave as 2D, so the tile weaves through it. Use a plain background (opaque or translucent), or a partial backdrop-filter on DisplayXR Browser 0.1.16+`);
      if (r.maxFrost >= 0.9) warns.push(`${r.selector}: at scroll ${r.maxFrostAt ?? '?'} a backdrop-filter covers the whole tile (the whole tile goes mono); frost only a partial region`);
      if (r.maxCovered >= 0.9 && r.samples > 1) warns.push(`${r.selector}: at scroll ${r.maxCoveredAt}px ${Math.round(r.maxCovered * 100)}% of the tile is under ${r.coverers[0] || 'an opaque element'}: a tall sticky panel or a later section painted over the canvas hides the tile while it keeps rendering`);
    }
    if (sweep.length) details.push({ scrollSweep: { steps: fake.scroll.steps, layers: sweep.map((r) => ({ selector: r.selector, maxCoveredPct: Math.round(r.maxCovered * 100), maxFrostPct: Math.round(r.maxFrost * 100), coverers: r.coverers.slice(0, 4), effects: r.effects })) } });
    const status = fails.length ? 'fail' : warns.length ? 'warn' : details.length ? 'pass' : 'skip';
    checks.push(check('overlay', 'f', 'No opaque element over the 3D canvas; the firstWoven cover comes off', status,
      fails[0] || warns[0] || (details.length ? 'canvas uncovered at the end of the run' : 'no woven canvas'), {
        details,
        doc: `${DOCS}/woven-canvas-rules.md#9-nothing-with-a-background-sits-above-the-woven-canvas-black-goes-under-it`,
      }));
  }

  // (f4) layer loss: after the session ends, no tile may be left showing its side-by-side pair
  {
    const L = fake.loss;
    const fails = [], warns = [];
    if (L && L.layers) {
      for (const r of L.layers) {
        if (!r.shown || !r.measured) continue;
        if (r.sbs) fails.push(`${r.selector}: after the inline-3D session ended, the canvas still shows its side-by-side pair (unwoven, two half-width copies). An addScene page must pass onLayerLost and draw ONE mono view across the canvas there (or hide it behind a 2D fallback); an empty onLayerLost is the same as none`);
        else if (r.blank) warns.push(`${r.selector}: after the inline-3D session ended, the canvas is empty: draw a mono view in onLayerLost (or show a 2D fallback)`);
      }
    }
    const status = !L || L.error || !L.ended ? 'skip' : fails.length ? 'fail' : warns.length ? 'warn' : 'pass';
    checks.push(check('layer-lost', 'f', 'When the 3D layer goes away, the page goes flat (onLayerLost), not a raw pair', status,
      fails[0] || warns[0] || (status === 'skip' ? (L && L.error ? `probe failed: ${L.error}` : 'no session to end') : `${L.layers.filter((r) => r.measured).length} canvas(es) went flat after the session ended`), {
        details: L,
        hint: fails.length || warns.length ? 'wall.addScene(canvas, onFrame, { onLayerLost: () => startMonoLoop() }): render one camera across the whole canvas on your own requestAnimationFrame, the same path as !wall.supported. SceneViewer: onLayerLost: viewer.onLayerLost. ./splat and ./model do this for you.' : undefined,
        doc: `${DOCS}/authoring-inline-3d.md#3-live-scene-threejs--webgl--addscenecanvas-onframe-opts`,
      }));
  }

  // (g) console / GL
  {
    const c = classify(fake.log, fake.shaderErrors);
    const status = c.errors.length || c.gl.length ? 'fail' : c.sdkWarnings.length ? 'warn' : 'pass';
    checks.push(check('console', 'g', 'No console errors, shader or GL errors', status,
      c.gl[0] ? `GL/shader: ${c.gl[0]}` : c.errors[0] || (c.sdkWarnings[0] ? `SDK warning: ${c.sdkWarnings[0]}` : 'clean console'), {
        details: c,
        hint: c.sdkWarnings.length && !c.errors.length && !c.gl.length ? 'The SDK warns ([inline3d] ...) only about a page mistake it detected. Read the message: it names the fix.' : undefined,
      }));
  }

  // (h) 2D fallback
  if (plain) {
    const c = classify(plain.log, plain.shaderErrors);
    const fails = [], details = { errors: c.errors, gl: c.gl, regions: [] };
    if (c.errors.length) fails.push(`errors without inline 3D: ${c.errors[0]}`);
    if (c.gl.length) fails.push(`GL/shader errors without inline 3D: ${c.gl[0]}`);
    for (const r of plain.regions || []) {
      if (r.missing) { details.regions.push({ selector: r.selector, missing: true }); continue; }
      const st = r.visible ? r.stats || null : null;
      details.regions.push({ selector: r.selector, visible: r.visible, contentPct: st ? +(st.contentFraction * 100).toFixed(2) : null });
      if (r.visible && st && st.blank) {
        // Something else may stand in for it (an <img> fallback over the same box).
        fails.push(`${r.selector}: shows nothing in a plain browser (draw a mono view, or show a 2D fallback)`);
      }
    }
    if (!plain.regions.length && !fake.layers.length && !c.errors.length) details.note = 'no woven canvas in the 3D run to compare against';
    checks.push(check('fallback-2d', 'h', 'Still renders in a plain browser (2D fallback)', fails.length ? 'fail' : 'pass',
      fails[0] || `no errors without inline 3D; ${details.regions.filter((r) => r.contentPct > 0).length}/${details.regions.length} canvas region(s) show content`, {
        details,
        hint: fails.length ? 'Branch on wall.supported (or the viewer\'s mono path): render one camera to the canvas, or show an <img>/poster. Never leave the canvas empty or show the packed pair.' : undefined,
        doc: `${DOCS}/authoring-inline-3d.md#detecting-support--do-this-not-that`,
      }));
  } else {
    checks.push(check('fallback-2d', 'h', 'Still renders in a plain browser (2D fallback)', 'skip', 'skipped (--no-fallback)'));
  }

  // detection anti-patterns (static + runtime)
  {
    const warns = [];
    const st = fake.statics;
    if (S.isSessionSupportedCalls.some((c) => c.mode === 'inline-3d') || st.isSessionSupported.length) warns.push(`gates on navigator.xr.isSessionSupported('inline-3d') (${st.isSessionSupported[0] || 'at runtime'}): it can resolve false before the weave service binds. Use createInline3D() / inline3DAvailable().`);
    if (st.uaSniff.length) warns.push(`reads the user agent next to "DisplayXR" (${st.uaSniff[0]}): detect by capability (createInline3D, inline3DAvailable), never the UA string (the Android browser sends a desktop UA).`);
    checks.push(check('detection', 'f', 'Detects support by capability, not isSessionSupported or the UA string', warns.length ? 'warn' : 'pass', warns[0] || 'no isSessionSupported/UA gating seen', { details: warns, approximate: true }));
  }

  // version pins (import maps + package.json)
  {
    const warns = [], seen = [];
    const exact = (u, name) => new RegExp(`${name.replace(/[/.]/g, (c) => `\\${c}`)}@\\d+\\.\\d+\\.\\d+(?![\\w.-]*[x*])`).test(u);
    for (const m of fake.statics.importMaps) {
      for (const [k, v] of Object.entries(m.imports || {})) {
        if (!/^https?:/.test(v)) continue;
        for (const name of ['@displayxr/inline3d', 'playcanvas', 'three']) {
          if (k === name || k.startsWith(`${name}/`)) {
            seen.push(`${k} -> ${v}`);
            if (!exact(v, name)) warns.push(`import map pins ${k} loosely (${v}): pin an exact version`);
          }
        }
      }
    }
    if (opt.packageJson) {
      const deps = { ...(opt.packageJson.dependencies || {}), ...(opt.packageJson.devDependencies || {}) };
      for (const name of ['@displayxr/inline3d', 'playcanvas', 'three']) {
        if (!deps[name]) continue;
        seen.push(`${name}@${deps[name]}`);
        if (!/^\d+\.\d+\.\d+$/.test(deps[name])) warns.push(`package.json pins ${name} as "${deps[name]}": pin an exact version`);
      }
    }
    checks.push(check('pins', '-', 'Exact version pins for @displayxr/inline3d, playcanvas, three', warns.length ? 'warn' : seen.length ? 'pass' : 'skip', warns[0] || (seen.length ? seen.join('; ') : 'no CDN import map or package.json found'), { details: { seen, warns }, approximate: true }));
  }

  // depth / comfort (measured)
  {
    let status = 'skip', summary = 'no stereo pair to measure';
    let details = null;
    const zone = shibataZoneMm(0.65);
    if (primary && primary.px && primary.px.blocks.length >= 3 && primary.occlusion) {
      const k = (primary.occlusion.rect.width / primary.px.eyeW) * MPP * 1000; // mm per eye px
      const ds = primary.px.blocks.map((b) => b.d * k);
      const p05 = quantile(ds, 0.05), p50 = quantile(ds, 0.5), p95 = quantile(ds, 0.95);
      details = { frontMostMm: +p05.toFixed(2), medianMm: +p50.toFixed(2), backMostMm: +p95.toFixed(2), comfortZoneMm: { front: +zone.frontMm.toFixed(1), behind: +zone.behindMm.toFixed(1) }, blocks: ds.length, sign: '- = in front of the glass, + = behind' };
      const warns = [];
      if (p05 < -zone.frontMm) warns.push(`pops out ${(-p05).toFixed(1)} mm (comfort zone ${zone.frontMm.toFixed(1)} mm in front)`);
      if (p95 > zone.behindMm) warns.push(`recedes ${p95.toFixed(1)} mm (comfort zone ${zone.behindMm.toFixed(1)} mm behind)`);
      const span = Math.max(1e-6, p95 - p05);
      if (Math.abs(p50) > Math.max(1.5, 0.6 * span) && (p05 > 0 || p95 < 0)) warns.push(`the subject sits entirely ${p50 > 0 ? 'behind' : 'in front of'} the glass (median ${p50.toFixed(1)} mm): centre it on z = 0`);
      status = warns.length ? 'warn' : 'pass';
      summary = warns.length ? warns.join('; ') : `screen disparity ${p05.toFixed(1)} … ${p95.toFixed(1)} mm (median ${p50.toFixed(1)}), inside the comfort zone`;
    }
    checks.push(check('depth', '-', 'Depth sits on the glass and inside the comfort zone (measured, approximate)', status, summary, { details, approximate: true, doc: `${DOCS}/making-3d-look-right.md` }));
  }
  return checks;
}

function rigInfo(fake) {
  const p = fake.layers[0];
  if (!p) return { type: null, comfort: null };
  const rig = p.rig;
  if (!rig) return { type: 'display', source: p.init && p.init.virtualDisplayHeight ? 'virtualDisplayHeight' : 'browser default', virtualDisplayHeight: p.init ? p.init.virtualDisplayHeight || null : null, comfort: null, rigPushes: p.rigPushes };
  const type = rig.type === 'camera' ? 'camera' : 'display';
  const out = { type, rigPushes: p.rigPushes, ...Object.fromEntries(Object.entries(rig).filter(([k]) => k !== 'type')) };
  if (type === 'camera') {
    const ipd = typeof rig.ipdFactor === 'number' ? rig.ipdFactor : 1;
    const m2v = rig.metersToVirtual || 1;
    const dio = typeof rig.convergenceDiopters === 'number' ? rig.convergenceDiopters : 0;
    out.comfort = +(ipd * m2v * dio * 0.65).toFixed(3);
    out.comfortNote = 'ipdFactor x metersToVirtual x convergenceDiopters x 0.65 m (nominal viewer); keep <= 1';
  } else {
    out.comfort = null;
    out.comfortNote = 'display rig: ipdFactor/parallaxFactor are relative comfort dials in [0,1]';
  }
  return out;
}

// ------------------------------------------------------------------------------ entry point
export async function runCheck(target, opt = {}) {
  const o = {
    root: undefined,
    maxTexture: 0,
    timeoutMs: 15000,
    loadTimeoutMs: 20000,
    plainTimeoutMs: 6000,
    settleMs: 1600,
    noSessionGiveUpMs: 5000,
    fallback: true,
    viewport: { width: 1280, height: 800, dpr: 1 },
    ...opt,
  };
  const t0 = Date.now();
  const tgt = await resolveTarget(target, o.root);
  if (tgt.kind !== 'url' && !o.packageJson) {
    for (let d = tgt.kind === 'dir' ? tgt.file : dirname(tgt.file); d.startsWith(tgt.root) || d === tgt.root; d = dirname(d)) {
      const pj = join(d, 'package.json');
      if (existsSync(pj)) { try { o.packageJson = JSON.parse(readFileSync(pj, 'utf8')); } catch { /* ignore */ } break; }
      if (d === tgt.root || dirname(d) === d) break;
    }
  }
  let origin = null;
  try { origin = new URL(tgt.url).origin; } catch { /* keep null */ }
  const browser = await launchChrome({
    width: o.viewport.width,
    height: o.viewport.height,
    extraArgs: o.maxTexture ? [`--webgl_or_caps_max_texture_size_limit_${o.maxTexture}`] : [],
  });
  let fake, plain = null;
  try {
    fake = await fakeRun(browser.conn, tgt.url, o, origin);
    if (o.fallback) plain = await plainRun(browser.conn, tgt.url, o, fake, origin);
  } finally {
    await browser.close();
    if (tgt.server) await tgt.server.close();
  }
  const checks = buildChecks(fake, plain, o);
  const verdict = checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') ? 'warn' : 'pass';
  const S = fake.summary || {};
  return {
    tool: 'inline3d-check',
    version: VERSION,
    target,
    url: tgt.url,
    verdict,
    durationMs: Date.now() - t0,
    options: { maxTexture: o.maxTexture || null, viewport: o.viewport, fallback: o.fallback },
    environment: { fakeDisplay: { widthM: 0.3456, heightM: 0.1944, pixels: [1920, 1080], viewerM: 0.65, eyeSeparationM: 0.063 } },
    checks,
    info: {
      rig: rigInfo(fake),
      comfort: rigInfo(fake).comfort,
      layers: fake.layers.map((l) => ({ selector: l.selector, rect: l.occlusion && l.occlusion.rect, buffer: l.buffer && { width: l.buffer.width, height: l.buffer.height, contextType: l.buffer.contextType }, ageMs: Math.round(l.ageMs) })),
      frames: S.frames || 0,
      framesWithViews: S.framesWithViews || 0,
      modeRequests: S.modeRequests || [],
      fakeRunMs: fake.ms,
      plainRunMs: plain ? plain.ms : null,
    },
  };
}

export function formatHuman(r) {
  const icon = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', skip: 'skip' };
  const lines = [];
  lines.push(`inline3d-check ${r.version}  ${r.url}`);
  for (const c of r.checks) {
    lines.push(`  ${icon[c.status].padEnd(4)}  ${c.letter !== '-' ? `(${c.letter}) ` : '    '}${c.id.padEnd(15)} ${c.summary}${c.approximate ? '  [approx]' : ''}`);
    if ((c.status === 'fail' || c.status === 'warn') && c.hint) lines.push(`        fix: ${c.hint}`);
    if ((c.status === 'fail' || c.status === 'warn') && c.doc) lines.push(`        see: ${c.doc}`);
  }
  const rig = r.info.rig;
  lines.push(`  rig: ${rig.type || 'n/a'}${rig.type === 'camera' ? `, comfort ${rig.comfort} (keep <= 1)` : ''}${rig.virtualDisplayHeight ? `, virtualDisplayHeight ${rig.virtualDisplayHeight}` : ''}`);
  lines.push(`  verdict: ${r.verdict.toUpperCase()} in ${(r.durationMs / 1000).toFixed(1)} s`);
  return lines.join('\n');
}

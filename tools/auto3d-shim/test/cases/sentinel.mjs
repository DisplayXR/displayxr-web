// Sentinel cases (P0 slice A): what the sentinel costs a page that has no engine, the page's
// <meta name="displayxr-auto3d" content="off"> opt-out, detect-only under a user block, and the
// PlayCanvas coverage gap it cannot close (a script-created canvas, no globals). Product mode (the
// fake host) unless noted; assertions read window.__dxrFakeHost and a PROBE injected before the
// shim, which snapshots window keys and prototype descriptors and counts pending timers.

import { readFileSync } from 'node:fs';
const FAKE = readFileSync(new URL('../fake-xr.js', import.meta.url), 'utf8');

// Injected after fake-xr.js and BEFORE the shim. Page-visible on purpose (it is the harness); its
// own key, __dxrProbe, is excluded from the "new window keys" check.
const PROBE = `(() => {
  const keys0 = Object.getOwnPropertyNames(window);
  const protos = { Object: Object.prototype, EventTarget: EventTarget.prototype, Node: Node.prototype, Element: Element.prototype,
    HTMLElement: HTMLElement.prototype, HTMLCanvasElement: HTMLCanvasElement.prototype, Document: Document.prototype, Window: Window.prototype };
  const snap = (o) => { const m = new Map(); for (const k of Reflect.ownKeys(o)) m.set(k, Object.getOwnPropertyDescriptor(o, k)); return m; };
  const before = {}; for (const n of Object.keys(protos)) before[n] = snap(protos[n]);
  const same = (a, b) => !!a && !!b && a.get === b.get && a.set === b.set && a.value === b.value && a.enumerable === b.enumerable && a.configurable === b.configurable && a.writable === b.writable;
  const pending = new Map(); let created = 0;
  const sT = setTimeout, sI = setInterval, cT = clearTimeout, cI = clearInterval;
  const where = () => (new Error().stack || '').split('\\n').slice(2, 5).map((s) => s.trim()).join(' < ');
  window.setTimeout = function (fn, ms, ...a) {
    const id = sT(function () { pending.delete(id); if (typeof fn === 'function') return fn.apply(this, a); }, ms);
    pending.set(id, 'timeout ' + ms + ' ms: ' + where()); created++; return id;
  };
  window.setInterval = function (fn, ms, ...a) { const id = sI(fn, ms, ...a); pending.set(id, 'interval ' + ms + ' ms: ' + where()); created++; return id; };
  window.clearTimeout = function (id) { pending.delete(id); return cT(id); };
  window.clearInterval = function (id) { pending.delete(id); return cI(id); };
  Object.defineProperty(window, '__dxrProbe', { value: {
    diff() {
      const protoChanges = [];
      for (const n of Object.keys(protos)) {
        const b = before[n], a = snap(protos[n]);
        for (const [k, d] of a) if (!same(d, b.get(k))) protoChanges.push(n + '.' + String(k) + (b.has(k) ? ' (changed)' : ' (added)'));
        for (const k of b.keys()) if (!a.has(k)) protoChanges.push(n + '.' + String(k) + ' (removed)');
      }
      const k0 = new Set(keys0);
      return { protoChanges, newKeys: Object.getOwnPropertyNames(window).filter((k) => !k0.has(k)), pending: [...pending.values()], created, pcInWindow: 'pc' in window };
    },
  } });
})();`;

const hostRead = () => {
  const H = window.__dxrFakeHost || null;
  const cv = document.querySelector('canvas:not([data-dxr-auto3d-cover])');
  return {
    host: H && { loadCore: H.loadCore, sentinelMs: H.sentinelMs, saves: H.saves, reports: H.reports.map(({ status, engine, reason }) => ({ status, engine, reason })) },
    fake: { sessions: window.__fakeXR.sessions.length, layers: window.__fakeXR.layers.length, closed: window.__fakeXR.layers.filter((l) => l.closedAt !== null).length },
    canvasOwnId: cv ? !!Object.getOwnPropertyDescriptor(cv, 'id') : null,
    pageFrames: window.__pageFrames ?? null,
  };
};
const rep = (H) => (H ? H.reports.map((x) => x.status + (x.engine ? ':' + x.engine : '')).join(' -> ') || '(none)' : 'no host');
const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// div.id reads over the page's 2,000 elements: the best of 9 runs of 1,000 passes.
const idBench = () => {
  const els = [...document.querySelectorAll('#root > *')];
  let best = Infinity, n = 0;
  for (let r = 0; r < 9; r++) {
    const t0 = performance.now();
    for (let k = 0; k < 1000; k++) for (let i = 0; i < els.length; i++) n += els[i].id.length;
    best = Math.min(best, performance.now() - t0);
  }
  return { ms: best, n, els: els.length };
};

export default function cases({ P, NEW, productShim }) {
  const shim = productShim({ decision: 'allow' });
  const lines = (r, re) => r.log.filter((l) => re.test(l));
  return [
    {
      id: 's-cost', name: 'sentinel cost on a plain 2,000-element page (product): no core, no timers, only the documented surface',
      url: P + 'plain-2000.html', shim: [PROBE, ...shim],
      async run(page, h) {
        const url = page.url();
        const out = { loads: [] };
        // Five document loads: the sentinel's own cost (eval + run) each time.
        for (let i = 0; i < 5; i++) {
          if (i) await page.reload({ waitUntil: 'load' });
          await h.sleep(300);
          out.loads.push(await page.evaluate(() => ({ ...(() => { const H = window.__dxrFakeHost; return { sentinelMs: H.sentinelMs, loadCore: H.loadCore, reports: H.reports.length }; })() })));
        }
        await h.sleep(1200); // anything the sentinel scheduled at load would still be pending here
        out.probe = await page.evaluate(() => window.__dxrProbe.diff());
        out.X = await page.evaluate(hostRead);
        out.url = url;
        // div.id read cost against a control: the same page with the same fake XR + probe but no
        // shim. Each measurement is a fresh tab (same visibility, same state), alternating order.
        const tab = async (scripts) => {
          const p = await page.browserContext().newPage();
          await p.setViewport({ width: h.W, height: h.H, deviceScaleFactor: 1 });
          for (const s of scripts) await p.evaluateOnNewDocument(s);
          await p.goto(url, { waitUntil: 'load' });
          await h.sleep(150);
          const b = await p.evaluate(idBench);
          await p.close();
          return b.ms;
        };
        const shimB = [], ctlB = [];
        for (let i = 0; i < 10; i++) {
          if (i % 2) { shimB.push(await tab([FAKE, PROBE, ...shim])); ctlB.push(await tab([FAKE, PROBE])); }
          else { ctlB.push(await tab([FAKE, PROBE])); shimB.push(await tab([FAKE, PROBE, ...shim])); }
        }
        out.bench = { ratio: median(shimB.map((x, i) => x / ctlB[i])), shim: median(shimB), control: median(ctlB), shimRuns: shimB, controlRuns: ctlB };
        return out;
      },
      check(r, t) {
        if (!r.ok) { t('ran', false, r.error); return; }
        const L = r.loads, D = r.probe, X = r.X;
        t('cap.loadCore() never called (5 loads)', L.every((x) => x.loadCore === 0), L.map((x) => x.loadCore).join(','));
        t('nothing reported (a page with no engine says nothing)', L.every((x) => x.reports === 0), L.map((x) => x.reports).join(','));
        t('prototypes: only HTMLCanvasElement.prototype.getContext changed', D.protoChanges.length === 1 && D.protoChanges[0] === 'HTMLCanvasElement.getContext (changed)', D.protoChanges.join(', ') || '(none)');
        t("'pc' in window is false", D.pcInWindow === false, String(D.pcInWindow));
        t('no timers pending (and none scheduled)', D.pending.length === 0 && D.created === 0, `pending ${D.pending.length}, created ${D.created}` + (D.pending.length ? ': ' + D.pending.join(' | ') : ''));
        const keys = D.newKeys.filter((k) => k !== '__dxrFakeHost' && k !== '__dxrProbe');
        t('the only new window key is __THREE_DEVTOOLS__ (besides the harness\'s __dxrFakeHost / __dxrProbe)', keys.length === 1 && keys[0] === '__THREE_DEVTOOLS__', D.newKeys.join(', '));
        const ms = L.map((x) => x.sentinelMs);
        t('sentinel eval + run < 0.5 ms (median of 5 loads)', median(ms) < 0.5, `median ${median(ms).toFixed(3)} ms; runs ${ms.map((x) => x.toFixed(3)).join(', ')}`);
        const B = r.bench, dev = B.ratio - 1;
        t('div.id read cost within ±5 % of a control page', Math.abs(dev) <= 0.05, `${(dev * 100).toFixed(1)} % (median of 10 shim/control pairs, fresh tabs, order alternating, each the best of 9 runs × 2M reads: shim ${B.shim.toFixed(2)} ms, control ${B.control.toFixed(2)} ms; shim ${B.shimRuns.map((x) => x.toFixed(2)).join('/')}, control ${B.controlRuns.map((x) => x.toFixed(2)).join('/')})`);
        t('no canvas, so no id trap anywhere', X.canvasOwnId === null, String(X.canvasOwnId));
      },
    },
    {
      id: 's-meta', name: 'meta opt-out, static (<meta name="DisplayXR-Auto3D" content=" OFF ">): core never loaded, report optout, 2D',
      url: P + 'meta-off.html', shim: productShim({ decision: 'allow' }),
      async run(page, h) {
        await page.waitForFunction('window.__pageFrames > 120', { timeout: 30000, polling: 100 });
        await h.sleep(800);
        return { X: await page.evaluate(hostRead) };
      },
      check(r, t) {
        const X = r.X, H = X && X.host;
        t('cap.loadCore() never called', r.ok && H && H.loadCore === 0, r.error || `loadCore ${H && H.loadCore}`);
        t('one report: optout', H && H.reports.length === 1 && H.reports[0].status === 'optout', rep(H));
        t('no session, no layer (2D)', X && X.fake.sessions === 0 && X.fake.layers === 0, JSON.stringify(X && X.fake));
        t('no id trap left on the canvas', X && X.canvasOwnId === false, String(X && X.canvasOwnId));
        const l = lines(r, /opted out/);
        t('one console line says why', l.length === 1, l.join(' | ') || '(none)');
      },
    },
    {
      id: 's-meta-boot', name: 'meta opt-out inserted after three.js loaded the core, before the first draw: considerActivation refuses',
      url: P + 'meta-off.html?late=boot', shim: productShim({ decision: 'allow' }),
      async run(page, h) {
        await page.waitForFunction('window.__pageFrames > 120', { timeout: 30000, polling: 100 });
        await h.sleep(800);
        return { X: await page.evaluate(hostRead) };
      },
      check(r, t) {
        const X = r.X, H = X && X.host;
        t('the core loaded (three.js announced itself before the meta existed)', r.ok && H && H.loadCore === 1, r.error || `loadCore ${H && H.loadCore}`);
        t('reports end at optout; never converting / live', H && H.reports.length >= 1 && H.reports[H.reports.length - 1].status === 'optout' && !H.reports.some((x) => x.status === 'converting' || x.status === 'live'), rep(H));
        t('no session (2D)', X && X.fake.sessions === 0, JSON.stringify(X && X.fake));
      },
    },
    {
      id: 's-meta-late', name: 'meta opt-out inserted 2.5 s into the page, while converted: turned off within 30 session frames, report optout',
      url: P + 'meta-off.html?late=2500', shim: productShim({ decision: 'allow' }),
      async run(page, h) {
        await page.waitForFunction(() => { const H = window.__dxrFakeHost; return !!(H && H.reports.some((x) => x.status === 'live')); }, { timeout: 30000, polling: 100 });
        const live = await page.evaluate(() => ({ metaAt: window.__metaAt ?? null }));
        await page.waitForFunction(() => window.__metaAt != null, { timeout: 10000, polling: 50 });
        let closed = true;
        try { await page.waitForFunction(() => window.__fakeXR.layers.some((l) => l.closedAt !== null), { timeout: 5000, polling: 50 }); } catch { closed = false; }
        const offAt = await page.evaluate(() => { const l = window.__fakeXR.layers.find((x) => x.closedAt !== null); return { metaAt: window.__metaAt, closedAt: l ? l.closedAt : null }; });
        await h.sleep(2000); // must not come back
        return { live, closed, offAt, X: await page.evaluate(hostRead) };
      },
      check(r, t) {
        const X = r.X, H = X && X.host;
        t('went live before the meta appeared', r.ok && r.live && r.live.metaAt === null, r.error || JSON.stringify(r.live));
        const dt = r.offAt && r.offAt.closedAt !== null ? r.offAt.closedAt - r.offAt.metaAt : NaN;
        t('layer closed after the meta appeared (fade + staged stand), within 2 s', r.closed && dt > 0 && dt < 2000, `closed ${isFinite(dt) ? dt.toFixed(0) + ' ms' : 'never'} after the meta`);
        t('reports: ... live -> optout, and it stays there', H && H.reports.length >= 2 && H.reports[H.reports.length - 1].status === 'optout' && H.reports.some((x) => x.status === 'live'), rep(H));
        t('one session, one layer: no retry after the opt-out', X && X.fake.sessions === 1 && X.fake.layers === 1 && X.fake.closed === 1, JSON.stringify(X && X.fake));
        const l = lines(r, /opted out/);
        t('the console names the reason', l.length >= 1, l.join(' | ') || '(none)');
      },
    },
    {
      id: 's-block-pc', name: 'user block (product), PlayCanvas: detect-only, one { off, PlayCanvas } report, traps removed',
      url: P + 'pc-mesh.html', shim: productShim({ decision: 'block' }),
      async run(page, h) {
        await page.waitForFunction('window.__frozen', { timeout: 30000, polling: 100 });
        await h.sleep(1000);
        return { X: await page.evaluate(hostRead) };
      },
      check(r, t) {
        const X = r.X, H = X && X.host;
        t('cap.loadCore() never called', r.ok && H && H.loadCore === 0, r.error || `loadCore ${H && H.loadCore}`);
        t('exactly one report: { status: off, engine: PlayCanvas }', H && H.reports.length === 1 && H.reports[0].status === 'off' && H.reports[0].engine === 'PlayCanvas', rep(H));
        t('no session', X && X.fake.sessions === 0, JSON.stringify(X && X.fake));
        t('the canvas id trap is gone', X && X.canvasOwnId === false, String(X && X.canvasOwnId));
      },
    },
    {
      id: 's-pc-dyn', name: 'PlayCanvas on a script-created canvas, no globals (R1 gap): the page keeps working; the sentinel says why it stays 2D',
      url: P + 'pc-dyn.html', shim: productShim({ decision: 'allow' }), timeoutMs: 40000,
      async run(page, h) {
        await page.waitForFunction('window.__pageFrames > 60', { timeout: 30000, polling: 100 });
        // The globals search runs 40 x 500 ms from the first WebGL context; the verdict comes at its end.
        try { await page.waitForFunction(() => { const H = window.__dxrFakeHost; return !!(H && H.reports.some((x) => x.status === 'live')); }, { timeout: 23000, polling: 250 }); } catch { /* 2D: expected today */ }
        const f0 = await page.evaluate(() => window.__pageFrames);
        await h.sleep(500);
        return { X: await page.evaluate(hostRead), f0 };
      },
      check(r, t) {
        const X = r.X, H = X && X.host;
        const live = !!(H && H.reports.some((x) => x.status === 'live'));
        t(`coverage: ${live ? '3D (found!)' : '2D (not seen — expected today)'}`, r.ok, r.error || `reports ${rep(H)}, loadCore ${H && H.loadCore}, sessions ${X && X.fake.sessions}`);
        const errs = r.log.filter((l) => /pageerror/.test(l));
        t('the page keeps working (frames advance, no page error)', X && X.pageFrames > r.f0 && !errs.length, `frames ${r.f0} -> ${X && X.pageFrames}; ${errs.join(' | ') || 'no page errors'}`);
        const l = lines(r, /no supported engine found/);
        t('3D, or one console line saying why not', live || l.length === 1, l.join(' | ') || '(no line)');
        t('the canvas id trap expired (load + 10 s)', X && X.canvasOwnId === false, String(X && X.canvasOwnId));
      },
    },
    {
      // The dev bundle is lazy too: on a page with no engine the core (HUD, hotkeys, __dxrAuto3D) never loads.
      id: 's-dev-plain', name: 'dev bundle on the plain page: the core is not loaded (no __dxrAuto3D, no HUD)',
      url: P + 'plain-2000.html', shim: NEW,
      async run(page, h) {
        await h.sleep(800);
        return { D: await page.evaluate(() => ({ dev: typeof window.__dxrAuto3D, hud: !!document.querySelector('[data-dxr-auto3d-hud]'), pc: 'pc' in window })) };
      },
      check(r, t) {
        t('no dev surface, no HUD, no pc', r.ok && r.D.dev === 'undefined' && !r.D.hud && !r.D.pc, r.error || JSON.stringify(r.D));
      },
    },
  ];
}

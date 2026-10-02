// The "3D" chip and its menu (chip.js; P0 plan §3, slice B). Product-mode host (fake-host.js: the
// cap.save / cap.report records) with dev ON where the case needs the chip's closed shadow root
// (__dxrAuto3D.chip() -> { root, host, state, corner, menu, rect, menuRect }). Input goes through
// real puppeteer mouse / keyboard events at the chip's coordinates, as a user's would.
//
// What these cannot judge: whether the panel weaves the chip. That is the woven-canvas rules (plain
// quad, smaller than the tile, no opacity / filter / transform / blend), asserted here only as CSS
// facts on the host / wrap / menu; the picture itself is for the panel.

// ------------------------------------------------------------ page-side readers
function chipInfo() {
  const c = window.__dxrAuto3D && window.__dxrAuto3D.chip();
  const cv = document.querySelector('#stage canvas');
  const r = cv && cv.getBoundingClientRect();
  if (!c) return { chip: null, canvas: r && { left: r.left, top: r.top, right: r.right, bottom: r.bottom } };
  const host = c.host;
  const out = { state: c.state, corner: c.corner, menu: c.menu, rect: c.rect, menuRect: c.menuRect,
    canvas: r && { left: r.left, top: r.top, right: r.right, bottom: r.bottom } };
  if (host) {
    out.topLayer = host.matches(':popover-open') && host.parentNode === document.documentElement;
    const wrap = c.root.querySelector('.wrap'), menu = c.root.querySelector('.menu'), pill = c.root.querySelector('.pill');
    const css = (el) => { const s = getComputedStyle(el); return { opacity: s.opacity, filter: s.filter, transform: s.transform, backdrop: s.backdropFilter, blend: s.mixBlendMode, pe: s.pointerEvents, pos: s.position }; };
    out.css = { host: css(host), wrap: css(wrap), menu: css(menu) };
    out.backdrop = getComputedStyle(host, '::backdrop').backgroundColor;
    out.expanded = wrap.classList.contains('exp');
    out.outline = wrap.classList.contains('outline');
    out.dot = c.root.querySelector('.dot').className;
    out.title = wrap.getAttribute('title');
    out.pill = { role: pill.getAttribute('role') || pill.tagName.toLowerCase(), tabindex: pill.getAttribute('tabindex'), pressed: pill.getAttribute('aria-pressed'),
      label: pill.getAttribute('aria-label'), haspopup: pill.getAttribute('aria-haspopup') };
    out.menuRole = menu.getAttribute('role');
    out.live = c.root.querySelector('[aria-live]').textContent;
    const a = c.root.activeElement;
    out.focus = a ? (a.getAttribute('data-k') || a.className) : null;
    out.docActive = document.activeElement ? document.activeElement.tagName.toLowerCase() + (document.activeElement.hasAttribute('data-dxr-auto3d-chip') ? '[chip]' : '') : null;
    if (c.rect) {
      const x = c.rect.left + 12, y = c.rect.top + c.rect.height / 2;
      out.hitFirst = (() => { const e = document.elementsFromPoint(x, y)[0]; return e === host ? 'host' : e ? e.tagName.toLowerCase() : null; })();
    }
  }
  return out;
}
const host = () => {
  const H = window.__dxrFakeHost;
  return H ? { saves: H.saves.slice(), reports: H.reports.map((r) => r.status), last: H.reports[H.reports.length - 1] } : null;
};
const liveChip = () => { const c = window.__dxrAuto3D && window.__dxrAuto3D.chip(); return !!(c && c.state === 'live' && c.rect); };
const chipIn = (state) => `(() => { const c = window.__dxrAuto3D && window.__dxrAuto3D.chip(); return !!(c && c.state === '${state}' && c.rect); })()`;
const reportsLive = (n) => `(() => { const H = window.__dxrFakeHost; return !!(H && H.reports.filter((r) => r.status === 'live').length >= ${n}); })()`;
const W8 = { timeout: 30000, polling: 100 };

// The pill's / a menu item's centre, in page coordinates.
async function pillXY(page) { return page.evaluate(() => { const r = window.__dxrAuto3D.chip().rect; return [r.left + 12, r.top + r.height / 2]; }); }
async function itemXY(page, k) {
  return page.evaluate((key) => {
    const c = window.__dxrAuto3D.chip();
    const el = key === 'caret' ? c.root.querySelector('.caret') : c.root.querySelector(`[data-k="${key}"]`);
    const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2];
  }, k);
}

// ------------------------------------------------------------ the no-layout-change snapshot
// Every page element (outside our host and the cover) with its attributes and FULL computed style.
// Allowlisted (risk R7): the canvas's inline will-change / transform (promote()) and their
// computed values, and its width / height store attributes + intrinsic aspect-ratio (the SBS store,
// P0.2); the cover is excluded as an element.
function snapshot() {
  const skip = (e) => e.hasAttribute('data-dxr-auto3d-chip') || e.hasAttribute('data-dxr-auto3d-cover');
  const out = [];
  const walk = (e, path) => {
    if (skip(e)) return;
    // The converted-canvas marker (v0.5.6, data-dxr-auto3d="live") is OURS, by design: asserted on
    // its own in chip-layout, left out of the comparison.
    const attrs = [...e.attributes].filter((a) => !(e.tagName === 'CANVAS' && a.name === 'data-dxr-auto3d')).map((a) => {
      // The converted canvas's STORE is the side-by-side pair (2 x the device-pixel eye, P0.2): its
      // width / height attributes (and the intrinsic aspect-ratio they imply) change by design; its
      // BOX must not, and the box is compared below.
      if (e.tagName === 'CANVAS' && (a.name === 'width' || a.name === 'height')) return `${a.name}=(store)`;
      if (e.tagName === 'CANVAS' && a.name === 'style') {
        return 'style=' + a.value.split(';').map((x) => x.trim()).filter((x) => x && !/^(will-change|transform)\s*:/.test(x)).join(';');
      }
      return `${a.name}=${a.value}`;
    });
    const cs = getComputedStyle(e), st = {};
    for (let i = 0; i < cs.length; i++) {
      const k = cs[i];
      if (e.tagName === 'CANVAS' && (k === 'will-change' || k === 'transform' || k === 'aspect-ratio')) continue;
      st[k] = cs.getPropertyValue(k);
    }
    const r = e.getBoundingClientRect();
    out.push({ path, attrs: attrs.join(' '), box: [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 100) / 100).join(','), st });
    let i = 0;
    for (const ch of e.children) walk(ch, `${path}>${ch.tagName.toLowerCase()}[${i++}]`);
  };
  walk(document.documentElement, 'html');
  return out;
}
function diffSnap(a, b) {
  const d = [];
  if (a.length !== b.length) d.push(`element count ${a.length} -> ${b.length}`);
  const m = new Map(b.map((x) => [x.path, x]));
  for (const x of a) {
    const y = m.get(x.path);
    if (!y) { d.push(`gone: ${x.path}`); continue; }
    if (x.attrs !== y.attrs) d.push(`${x.path} attrs: ${x.attrs} -> ${y.attrs}`);
    if (x.box !== y.box) d.push(`${x.path} box: ${x.box} -> ${y.box}`);
    for (const k of Object.keys(x.st)) if (x.st[k] !== y.st[k]) d.push(`${x.path} ${k}: ${x.st[k]} -> ${y.st[k]}`);
  }
  return d;
}

export default function cases({ P, productShim }) {
  const allowDev = productShim({ decision: 'allow', dev: true });
  const noCss = (c) => c && c.opacity === '1' && c.filter === 'none' && c.transform === 'none' && c.backdrop === 'none' && c.blend === 'normal';
  return [
    {
      id: 'chip-place', name: 'chip: top layer, top-right inset 8, <= 64x28, plain quad, hit test hits the host; expanded 3 s then collapsed',
      url: P + 'three-corner-ui.html', shim: allowDev,
      async run(page, h) {
        await page.waitForFunction(liveChip, W8);
        const first = await page.evaluate(chipInfo);
        await h.sleep(3400);
        const later = await page.evaluate(chipInfo);
        return { first, later };
      },
      check(r, t) {
        const A = r.first, B = r.later;
        t('chip live and placed', r.ok && A && A.state === 'live' && !!A.rect, r.error || JSON.stringify(A));
        if (!A || !A.rect) return;
        t('host is in the top layer (popover open, child of <html>)', A.topLayer === true, `topLayer ${A.topLayer}`);
        t('top-right corner', A.corner === 'tr', `corner ${A.corner}`);
        t('inset 8 px from the canvas top-right', Math.abs(A.canvas.right - 8 - (A.rect.left + A.rect.width)) < 0.6 && Math.abs(A.rect.top - (A.canvas.top + 8)) < 0.6,
          `chip ${JSON.stringify(A.rect)} canvas ${JSON.stringify(A.canvas)}`);
        t('at most 64 x 28 CSS px', A.rect.width <= 64 && A.rect.height <= 28, `${A.rect.width}x${A.rect.height}`);
        t('no opacity / filter / transform / backdrop-filter / blend on host, wrap, menu', noCss(A.css.host) && noCss(A.css.wrap) && noCss(A.css.menu), JSON.stringify(A.css));
        t('host pointer-events none, wrap auto', A.css.host.pe === 'none' && A.css.wrap.pe === 'auto', `${A.css.host.pe} / ${A.css.wrap.pe}`);
        t('elementsFromPoint at the pill hits the host first', A.hitFirst === 'host', `first ${A.hitFirst}`);
        t('expanded at go-live, green or amber dot', A.expanded === true && /dot (g|a)/.test(A.dot), `expanded ${A.expanded}, ${A.dot}`);
        t('collapsed after 3 s, right edge kept, green dot once settled', B && B.expanded === false && B.rect && Math.abs((B.rect.left + B.rect.width) - (A.rect.left + A.rect.width)) < 0.6 && B.dot === 'dot g',
          `expanded ${B && B.expanded}, rect ${JSON.stringify(B && B.rect)}, ${B && B.dot}`);
        t('live region announced "3D view on"', A.live === '3D view on', JSON.stringify(A.live));
      },
    },
    {
      id: 'chip-fallback', name: 'chip: page UI over the top-right corner -> bottom-right',
      url: P + 'three-corner-ui.html?ui=tr', shim: allowDev,
      async run(page) {
        await page.waitForFunction(liveChip, W8);
        return { A: await page.evaluate(chipInfo) };
      },
      check(r, t) {
        const A = r.A;
        t('chip placed bottom-right', r.ok && A && A.corner === 'br', r.error || `corner ${A && A.corner}`);
        if (A && A.rect) t('inset 8 px from the canvas bottom-right', Math.abs(A.canvas.right - 8 - (A.rect.left + A.rect.width)) < 0.6 && Math.abs(A.canvas.bottom - 8 - (A.rect.top + A.rect.height)) < 0.6, JSON.stringify(A.rect));
      },
    },
    {
      id: 'chip-none', name: 'chip: page UI over all four corners -> no chip (still live)',
      url: P + 'three-corner-ui.html?ui=all', shim: allowDev,
      async run(page, h) {
        await page.waitForFunction(reportsLive(1), W8);
        await h.sleep(2500);
        return { A: await page.evaluate(chipInfo), H: await page.evaluate(host) };
      },
      check(r, t) {
        const A = r.A;
        t('went live', r.ok && r.H && r.H.reports.includes('live'), r.error || JSON.stringify(r.H));
        t('no chip shown (no corner, no rect)', A && A.corner === null && A.rect === null, JSON.stringify(A && { state: A.state, corner: A.corner, rect: A.rect }));
      },
    },
    {
      id: 'chip-click', name: 'chip: click turns off + saves block; click again back on + saves allow; "Just this time" saves nothing',
      url: P + 'three-corner-ui.html', shim: allowDev,
      async run(page, h) {
        await page.waitForFunction(liveChip, W8);
        await page.mouse.click(...(await pillXY(page)));
        await page.waitForFunction(chipIn('off'), W8);
        await h.sleep(200);
        const off = await page.evaluate(chipInfo), H1 = await page.evaluate(host);
        await page.waitForFunction("(() => { const H = window.__dxrFakeHost; return H.reports[H.reports.length - 1].status === 'off'; })()", W8);
        await page.mouse.click(...(await pillXY(page)));
        await page.waitForFunction(reportsLive(2), W8);
        await page.waitForFunction(liveChip, W8);
        const on = await page.evaluate(chipInfo), H2 = await page.evaluate(host);
        await page.mouse.click(...(await itemXY(page, 'caret')));
        await page.waitForFunction('window.__dxrAuto3D.chip().menu', W8);
        await page.mouse.click(...(await itemXY(page, 'once')));
        await page.waitForFunction(chipIn('off'), W8);
        await h.sleep(800);
        const once = await page.evaluate(chipInfo), H3 = await page.evaluate(host);
        return { off, on, once, H1, H2, H3 };
      },
      check(r, t) {
        t('first click: chip off, outlined, expanded, aria-pressed false', r.ok && r.off && r.off.state === 'off' && r.off.outline && r.off.expanded && r.off.pill.pressed === 'false',
          r.error || JSON.stringify(r.off && { state: r.off.state, outline: r.off.outline, exp: r.off.expanded, pressed: r.off.pill.pressed }));
        t('first click saved { decision: block }', r.H1 && r.H1.saves.length === 1 && r.H1.saves[0].decision === 'block', JSON.stringify(r.H1 && r.H1.saves));
        t('the click did not move focus out of the page', r.off && r.off.docActive === 'body', `activeElement ${r.off && r.off.docActive}`);
        t('second click: live again, saved { decision: allow }', r.on && r.on.state === 'live' && r.H2 && r.H2.saves.length === 2 && r.H2.saves[1].decision === 'allow', JSON.stringify(r.H2 && r.H2.saves));
        t('"Just this time": off, nothing saved', r.once && r.once.state === 'off' && r.H3 && r.H3.saves.length === 2, JSON.stringify(r.H3 && r.H3.saves));
      },
    },
    {
      id: 'chip-offer', name: 'chip: offer mode shows an outlined pill; a click converts and saves { decision: allow }',
      url: P + 'three-corner-ui.html', shim: productShim({ decision: 'offer', dev: true }),
      async run(page, h) {
        await page.waitForFunction(chipIn('offer'), W8);
        const A = await page.evaluate(chipInfo), H0 = await page.evaluate(host);
        await page.mouse.click(...(await pillXY(page)));
        await page.waitForFunction(reportsLive(1), W8);
        await page.waitForFunction(liveChip, W8);
        return { A, H0, B: await page.evaluate(chipInfo), H1: await page.evaluate(host) };
      },
      check(r, t) {
        t('offer: outlined, collapsed, hollow dot, nothing converted', r.ok && r.A && r.A.state === 'offer' && r.A.outline && !r.A.expanded && r.A.dot === 'dot o' && !r.H0.reports.includes('live'),
          r.error || JSON.stringify(r.A && { s: r.A.state, o: r.A.outline, e: r.A.expanded, d: r.A.dot, rep: r.H0.reports }));
        t('offer label', r.A && /available/.test(r.A.pill.label), r.A && r.A.pill.label);
        t('click: live, saved exactly { decision: allow }', r.B && r.B.state === 'live' && r.H1.saves.length === 1 && r.H1.saves[0].decision === 'allow', JSON.stringify(r.H1 && r.H1.saves));
      },
    },
    {
      id: 'chip-input', name: 'chip: a drag starting on the pill reaches no page bubble listener, takes no focus, toggles nothing',
      url: P + 'three-corner-ui.html', shim: allowDev,
      async run(page, h) {
        await page.waitForFunction(liveChip, W8);
        await page.evaluate(() => {
          const n = (window.__seen = {});
          const cv = document.querySelector('#stage canvas');
          for (const [tgt, name] of [[cv, 'canvas'], [document, 'document'], [window, 'window']]) {
            for (const t of ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'mouseup', 'click', 'wheel', 'contextmenu']) {
              tgt.addEventListener(t, () => { n[`${name}.${t}`] = (n[`${name}.${t}`] || 0) + 1; });
            }
          }
        });
        const [x, y] = await pillXY(page);
        await page.mouse.move(x, y);
        await page.evaluate(() => { for (const k of Object.keys(window.__seen)) delete window.__seen[k]; });
        await page.mouse.down();
        for (let i = 1; i <= 10; i++) await page.mouse.move(x - i * 20, y + i * 10);
        await page.mouse.up();
        await page.mouse.move(x, y);
        await page.mouse.wheel({ deltaY: 100 });
        await h.sleep(300);
        return { seen: await page.evaluate(() => ({ ...window.__seen })), A: await page.evaluate(chipInfo), H: await page.evaluate(host) };
      },
      check(r, t) {
        t('no pointer / mouse / click / wheel event on canvas, document or window bubble listeners', r.ok && r.seen && Object.keys(r.seen).length === 0, r.error || JSON.stringify(r.seen));
        t('focus stayed on the page', r.A && r.A.docActive === 'body', `activeElement ${r.A && r.A.docActive}`);
        t('the drag was not a click: still live, nothing saved', r.A && r.A.state === 'live' && r.H.saves.length === 0, JSON.stringify(r.H && r.H.saves));
      },
    },
    {
      id: 'chip-layout', name: 'chip: NO LAYOUT CHANGE — page DOM, attributes, boxes and computed styles identical before / after go-live',
      url: P + 'three-corner-ui.html?startMs=1500', shim: productShim({ decision: 'allow' }),
      async run(page, h) {
        await page.waitForFunction("document.querySelector('#stage canvas')", W8);
        const before = await page.evaluate(snapshot);
        const sb = await page.evaluate(host);
        await page.waitForFunction(reportsLive(1), W8);
        await page.waitForFunction("(() => { const e = document.querySelector('[data-dxr-auto3d-chip]'); return !!e && !document.querySelector('[data-dxr-auto3d-cover]'); })()", W8);
        await h.sleep(500);
        const after = await page.evaluate(snapshot);
        const hostOn = await page.evaluate(() => { const e = document.querySelector('[data-dxr-auto3d-chip]'); return !!e && e.parentNode === document.documentElement && e.matches(':popover-open'); });
        const marker = await page.evaluate(() => [...document.querySelectorAll('[data-dxr-auto3d]')].map((e) => `${e.tagName.toLowerCase()}=${e.getAttribute('data-dxr-auto3d')}`));
        return { diff: diffSnap(before, after), n: before.length, sb, hostOn, marker, noDev: await page.evaluate(() => typeof window.__dxrAuto3D) };
      },
      check(r, t) {
        t('the only attribute added to a page element is the converted canvas\'s data-dxr-auto3d="live"', r.marker && r.marker.join(',') === 'canvas=live', JSON.stringify(r.marker));
        t('snapshot taken before anything converted', r.ok && r.sb && !r.sb.reports.includes('converting') && !r.sb.reports.includes('live'), r.error || JSON.stringify(r.sb));
        t('product mode (no dev surface), chip host present in the top layer', r.noDev === 'undefined' && r.hostOn === true, `dev ${r.noDev}, host ${r.hostOn}`);
        t(`no page element changed (${r.n} elements compared)`, r.diff && r.diff.length === 0, r.diff && r.diff.slice(0, 8).join(' | '));
      },
    },
    {
      id: 'chip-dialog', name: 'chip: a page <dialog> modal over the canvas hides the chip; closed, it comes back; ::backdrop neutralised',
      url: P + 'three-dialog.html', shim: allowDev,
      async run(page, h) {
        await page.waitForFunction(liveChip, W8);
        const A = await page.evaluate(chipInfo);
        await page.evaluate(() => window.__openDialog());
        let hid = true;
        try { await page.waitForFunction('!window.__dxrAuto3D.chip().rect', { timeout: 3000, polling: 50 }); } catch { hid = false; }
        const B = await page.evaluate(chipInfo);
        await page.evaluate(() => window.__closeDialog());
        let back = true;
        try { await page.waitForFunction(liveChip, { timeout: 3000, polling: 50 }); } catch { back = false; }
        return { A, B, hid, back };
      },
      check(r, t) {
        t('chip shown before the dialog', r.ok && r.A && !!r.A.rect, r.error || JSON.stringify(r.A && r.A.rect));
        t('page ::backdrop rule neutralised on the chip host', r.A && (r.A.backdrop === 'rgba(0, 0, 0, 0)' || r.A.backdrop === 'transparent'), r.A && r.A.backdrop);
        t('hidden while the modal is open (within 3 s)', r.hid && r.B && r.B.rect === null, JSON.stringify(r.B && { corner: r.B.corner, rect: r.B.rect }));
        t('back once the modal closed', r.back === true, `back ${r.back}`);
      },
    },
    {
      id: 'chip-a11y', name: 'chip: roles, menu arrows / Home / End, Escape closes and returns focus to the pill; menu inside the tile',
      url: P + 'three-corner-ui.html', shim: allowDev,
      async run(page, h) {
        await page.waitForFunction(liveChip, W8);
        await page.evaluate(() => { window.__keys = 0; document.addEventListener('keydown', () => window.__keys++); });
        await page.mouse.click(...(await itemXY(page, 'caret')));
        await page.waitForFunction('window.__dxrAuto3D.chip().menu', W8);
        const f = [];
        const at = async () => (await page.evaluate(chipInfo)).focus;
        f.push(await at());
        for (const k of ['ArrowDown', 'ArrowDown', 'End', 'Home', 'ArrowUp']) { await page.keyboard.press(k); f.push(await at()); }
        const M = await page.evaluate(chipInfo);
        // The depth slider: Right on it changes the live depth (0.50 -> 0.51) and saves it.
        await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowRight');
        await h.sleep(100);
        const depth = await page.evaluate(() => window.__dxrAuto3D.state().depth);
        await page.keyboard.press('Escape');
        await h.sleep(100);
        const E = await page.evaluate(chipInfo);
        return { f, M, E, depth, H: await page.evaluate(host), keys: await page.evaluate(() => window.__keys) };
      },
      check(r, t) {
        const M = r.M, E = r.E;
        t('pill: <button> tabindex -1, aria-pressed true, aria-haspopup menu, full label', r.ok && M && M.pill.role === 'button' && M.pill.tabindex === '-1' && M.pill.pressed === 'true' && M.pill.haspopup === 'menu' && M.pill.label === '3D view: on. Turn off for this site',
          r.error || JSON.stringify(M && M.pill));
        t('menu role=menu, open', M && M.menuRole === 'menu' && M.menu === true, `${M && M.menuRole} ${M && M.menu}`);
        t('focus walk: site -> depth -> camera, End -> once, Home -> site, Up wraps -> once', r.f && r.f.join(',') === 'site,depth,camera,once,site,once', r.f && r.f.join(','));
        t('menu opens inside the tile, 8 px inset', M && M.menuRect && M.menuRect.left >= M.canvas.left + 8 && M.menuRect.left + M.menuRect.width <= M.canvas.right - 8 && M.menuRect.top >= M.canvas.top + 8 && M.menuRect.top + M.menuRect.height <= M.canvas.bottom - 8,
          JSON.stringify(M && M.menuRect));
        t('depth slider: ArrowRight 0.50 -> 0.51, saved', Math.abs(r.depth - 0.51) < 1e-9 && r.H.saves.some((s) => s.depths && Math.abs(s.depths.camera - 0.51) < 1e-9), `depth ${r.depth}, saves ${JSON.stringify(r.H && r.H.saves)}`);
        t('Escape closes the menu and returns focus to the pill', E && E.menu === false && E.focus === 'pill', `menu ${E && E.menu}, focus ${E && E.focus}`);
        t('no menu key reached the page\'s document keydown listener', r.keys === 0, `keys ${r.keys}`);
      },
    },
    {
      // P0.1 fix 2. A real fullscreen request (puppeteer's evaluate carries a user gesture), not a stub.
      id: 'chip-fs', name: 'chip in fullscreen: a fresh host PAINTED above the fullscreen canvas; hides after 3 s idle, back on a move; fresh again on exit',
      url: P + 'three-corner-ui.html', shim: allowDev,
      async run(page, h) {
        await page.waitForFunction(liveChip, W8);
        const hostIs = () => { const c = window.__dxrAuto3D.chip(); window.__hosts = window.__hosts || []; if (!window.__hosts.includes(c.host)) window.__hosts.push(c.host); return window.__hosts.indexOf(c.host); };
        const count = () => document.querySelectorAll('[data-dxr-auto3d-chip]').length;
        const h0 = await page.evaluate(hostIs);
        const A = await page.evaluate(chipInfo);
        await page.evaluate(() => document.querySelector('#stage canvas').requestFullscreen());
        await page.waitForFunction(() => document.fullscreenElement === document.querySelector('#stage canvas'), { timeout: 5000, polling: 50 });
        await page.waitForFunction(liveChip, W8);
        await h.sleep(200);
        const B = { ...(await page.evaluate(chipInfo)), host: await page.evaluate(hostIs), count: await page.evaluate(count),
          oldConnected: await page.evaluate(() => window.__hosts[0].isConnected), fs: await page.evaluate(() => !!document.fullscreenElement) };
        // What is PAINTED at the pill: the pill region with the chip shown, then (below) with it hidden
        // by the idle timer. Under the fullscreen element (the old host) the two would be identical.
        const clip = B.rect ? { x: Math.floor(B.rect.left), y: Math.floor(B.rect.top), width: Math.ceil(B.rect.width), height: Math.ceil(B.rect.height) } : null;
        const shot = async () => (clip ? page.screenshot({ clip, encoding: 'base64' }) : null);
        const shown = await shot();
        await h.sleep(3400); // no pointer movement: hides
        const idle = await page.evaluate(chipInfo);
        const hidden = await shot();
        const painted = shown && hidden ? await page.evaluate(async (a, b) => {
          const px = async (b64) => { const i = new Image(); i.src = 'data:image/png;base64,' + b64; await i.decode(); const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const g = c.getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
          const x = await px(a), y = await px(b); let e = 0; for (let k = 0; k < x.length; k += 4) e += Math.abs(x[k] - y[k]) + Math.abs(x[k + 1] - y[k + 1]) + Math.abs(x[k + 2] - y[k + 2]);
          return e / (x.length / 4) / 3;
        }, shown, hidden) : null;
        await page.mouse.move(300, 300); await page.mouse.move(320, 310);
        await h.sleep(150);
        const moved = await page.evaluate(chipInfo);
        await page.evaluate(() => document.exitFullscreen());
        await page.waitForFunction(() => !document.fullscreenElement, { timeout: 5000, polling: 50 });
        await page.waitForFunction(liveChip, W8);
        await h.sleep(200);
        const C = { ...(await page.evaluate(chipInfo)), host: await page.evaluate(hostIs), count: await page.evaluate(count) };
        return { h0, A, B, idle, moved, C, painted };
      },
      check(r, t) {
        const A = r.A, B = r.B, C = r.C;
        t('live chip before fullscreen, hit test hits it', r.ok && A && A.hitFirst === 'host', r.error || JSON.stringify(A && A.hitFirst));
        if (!B) return;
        t('fullscreen on the converted canvas; still live', B.fs && B.state === 'live', `fullscreen ${B.fs}, state ${B.state}`);
        t('a NEW host, the old one torn down, exactly one in the document, in the top layer', B.host === 1 && !B.oldConnected && B.count === 1 && B.topLayer === true, `host #${B.host}, old connected ${B.oldConnected}, hosts ${B.count}, topLayer ${B.topLayer}`);
        // PAINTED above the fullscreen element: the pill region changes when the chip hides. (Not hit-tested:
        // Chromium sends pointer input over a fullscreen element to it, not to a later non-modal top-layer
        // popover — measured headless; so in fullscreen the chip shows state but does not take clicks.)
        t('painted above the fullscreen element: the pill region differs with the chip shown vs hidden', r.painted > 8, `mean |diff| ${r.painted == null ? 'n/a' : r.painted.toFixed(1)} levels; elementsFromPoint first: ${B.hitFirst}`);
        t('in fullscreen: hidden after 3 s without pointer movement', r.idle && r.idle.rect === null, JSON.stringify(r.idle && r.idle.rect));
        t('back on the next pointer move', r.moved && !!r.moved.rect, JSON.stringify(r.moved && { rect: r.moved.rect, hit: r.moved.hitFirst }));
        t('on exit: a fresh host again, one in the document, top layer, hit test hits it', C && C.host === 2 && C.count === 1 && C.topLayer === true && C.hitFirst === 'host', JSON.stringify(C && { host: C.host, count: C.count, top: C.topLayer, hit: C.hitFirst }));
      },
    },
    {
      // P0.2 fix 2: a session that never delivers two views (a second browser instance whose session got
      // XR_ERROR_LIMIT_REACHED stays mono) is "no display for this window" once coverMaxMs has passed.
      id: 'chip-cover-max', name: 'cover max hold: displayOk but never two views -> cover gone at ~coverMaxMs (5 s); chip OUTLINE "no display", report { flat, no-display } (never live)',
      url: P + 'three-corner-ui.html', shim: allowDev, fake: { viewsAfterMs: 1e9 },
      async run(page, h) {
        await page.waitForFunction(() => window.__fakeXR.layers.length === 1, W8);
        await h.sleep(2500);
        const mid = await page.evaluate(() => ({ cover: !!document.querySelector('[data-dxr-auto3d-cover]'), t: performance.now() - window.__fakeXR.layers[0].at }));
        await page.waitForFunction(() => !document.querySelector('[data-dxr-auto3d-cover]'), { timeout: 9000, polling: 25 });
        const gone = await page.evaluate(() => performance.now() - window.__fakeXR.layers[0].at);
        await page.waitForFunction(chipIn('nodisplay'), W8);
        await h.sleep(1500);
        const A = await page.evaluate(chipInfo);
        const S = await page.evaluate(() => { const s = window.__dxrAuto3D.state(); const r = s.renderers.find((x) => x.active); return { active: !!r, rampK: r && r.rampK, stereo: r && r.stats.stereo, noDisplay: r && r.noDisplay, open: window.__fakeXR.layers[0].closedAt === null }; });
        return { mid, gone, A, S, H: await page.evaluate(host) };
      },
      check(r, t) {
        t('cover still up 2.5 s in (past the 1.2 s hold: no stereo frame yet)', r.ok && r.mid && r.mid.cover, r.error || JSON.stringify(r.mid));
        if (!r.S) return;
        t('cover gone at ~5 s (4.9-5.6 s after the layer)', r.gone >= 4900 && r.gone <= 5600, `${Math.round(r.gone)} ms`);
        t('still converted, layer open, flat (rampK 0, no stereo frame): the stand-down rule is unchanged', r.S.active && r.S.open && r.S.rampK === 0 && r.S.stereo === 0 && r.S.noDisplay, JSON.stringify(r.S));
        t('chip: OUTLINE pill, hollow dot, tooltip "3D display not available to this window"', r.A && r.A.state === 'nodisplay' && !!r.A.rect && r.A.outline === true && r.A.dot === 'dot o' && r.A.title === '3D display not available to this window' && r.A.pill.label === r.A.title,
          JSON.stringify(r.A && { state: r.A.state, rect: !!r.A.rect, outline: r.A.outline, dot: r.A.dot, title: r.A.title, label: r.A.pill && r.A.pill.label }));
        t("reports: last is { flat, no-display }, never 'live'", r.H && r.H.last && r.H.last.status === 'flat' && r.H.last.reason === 'no-display' && !r.H.reports.includes('live'), r.H && `${r.H.reports.join(' -> ')}; last ${JSON.stringify(r.H.last)}`);
        t('the console says why', r.log.some((l) => /cover released at its 5000 ms maximum/.test(l)) && r.log.some((l) => /3D display not available to this window/.test(l)), '');
      },
    },
    {
      // P0.2 fix 2, the other trigger: the layer's display API says there is no display (displayOk false).
      // The stand-down is immediate (nothing is woven), and the chip still tells the user why.
      id: 'chip-no-display', name: 'no display behind the layer (displayOk false): back to 2D at once; chip OUTLINE "no display" with tooltip, report { flat, no-display }',
      url: P + 'three-corner-ui.html', shim: allowDev, fake: { noDisplay: true, viewsAfterMs: 1e9 },
      async run(page, h) {
        await page.waitForFunction(() => window.__fakeXR.layers.length === 1 && window.__fakeXR.layers[0].closedAt !== null, W8);
        const closedAfter = await page.evaluate(() => window.__fakeXR.layers[0].closedAt - window.__fakeXR.layers[0].at);
        await page.waitForFunction(chipIn('nodisplay'), W8);
        await h.sleep(800);
        const A = await page.evaluate(chipInfo);
        await page.mouse.click(...(await pillXY(page)));
        await h.sleep(300);
        const M = await page.evaluate(chipInfo);
        return { closedAfter, A, M, H: await page.evaluate(host) };
      },
      check(r, t) {
        t('the layer closed once the display probe answered "none" (~1.5 s)', r.ok && r.closedAfter > 1000 && r.closedAfter < 3500, r.error || `${Math.round(r.closedAfter)} ms`);
        if (!r.A) return;
        t('chip: OUTLINE pill, hollow dot, tooltip "3D display not available to this window"', r.A.state === 'nodisplay' && !!r.A.rect && r.A.outline === true && r.A.dot === 'dot o' && r.A.title === '3D display not available to this window',
          JSON.stringify({ state: r.A.state, rect: !!r.A.rect, outline: r.A.outline, dot: r.A.dot, title: r.A.title }));
        t("reports: last is { flat, no-display }, never 'live'", r.H && r.H.last && r.H.last.status === 'flat' && r.H.last.reason === 'no-display' && !r.H.reports.includes('live'), r.H && `${r.H.reports.join(' -> ')}; last ${JSON.stringify(r.H.last)}`);
        t('a click on the pill opens the menu (nothing to switch on), saves nothing', r.M && r.M.menu === true && r.H.saves.length === 0, `menu ${r.M && r.M.menu}, saves ${JSON.stringify(r.H && r.H.saves)}`);
      },
    },
    {
      // P0.2 fix 3: eye tracking flips isTracking 0/1 every few seconds; the dot is debounced (amber only
      // after 1 s continuously without two-view frames, green after 300 ms with them).
      id: 'chip-amber-debounce', name: 'chip dot: two views on/off every 500 ms keeps it GREEN; views gone for good -> amber after ~1 s (guard off: timing only)',
      url: P + 'three-corner-ui.html', shim: productShim({ decision: 'allow', dev: true, test: { guardFps: 0 } }), fake: { flipViewsMs: 500, viewsStopAfterMs: 6500 },
      async run(page, h) {
        await page.waitForFunction(liveChip, W8);
        // Record the dot every 25 ms from inside the page, times relative to the layer.
        await page.evaluate(() => {
          window.__dots = [];
          const at = window.__fakeXR.layers[0].at;
          window.__dotTimer = setInterval(() => { const c = window.__dxrAuto3D.chip(); window.__dots.push({ t: performance.now() - at, dot: c.root.querySelector('.dot').className, state: c.state }); }, 25);
        });
        await page.waitForFunction(() => performance.now() - window.__fakeXR.layers[0].at > 9500, { timeout: 15000, polling: 100 });
        const D = await page.evaluate(() => { clearInterval(window.__dotTimer); return { dots: window.__dots, noView: window.__fakeXR.noViewFrames || 0 }; });
        return { D, H: await page.evaluate(host) };
      },
      check(r, t) {
        const d = r.D && r.D.dots;
        t('recorded', r.ok && d && d.length > 100, r.error || `${d && d.length} samples`);
        if (!d) return;
        t('the fake really alternated (frames without views)', r.D.noView > 30, `${r.D.noView} frames without views`);
        const flip = d.filter((x) => x.t >= 2500 && x.t < 7400);
        const bad = flip.filter((x) => x.dot !== 'dot g' || x.state !== 'live');
        t('2.5-7.4 s (views flipping every 500 ms, the last 2-view run ends at 6.5 s): the dot stays GREEN', flip.length > 50 && bad.length === 0, `${flip.length} samples, ${bad.length} not green` + (bad[0] ? ` (first at ${Math.round(bad[0].t)} ms: ${bad[0].state} ${bad[0].dot})` : ''));
        const amber = d.find((x) => x.t >= 6500 && x.dot === 'dot a');
        t('views gone from 6.5 s: amber after >= 1 s (debounced), within 1.6 s', amber && amber.t >= 7450 && amber.t <= 8100, amber ? `amber at ${Math.round(amber.t)} ms (views stopped at 6500)` : 'never amber');
        const tail = d.filter((x) => x.t >= 8300);
        t('stays amber and live (views were seen: not "no display")', tail.length > 5 && tail.every((x) => x.dot === 'dot a' && x.state === 'live'), `${tail.length} samples; ${JSON.stringify(tail[tail.length - 1])}`);
      },
    },
  ];
}

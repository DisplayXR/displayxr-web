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
  return H ? { saves: H.saves.slice(), reports: H.reports.map((r) => r.status) } : null;
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
// computed values; the cover is excluded as an element.
function snapshot() {
  const skip = (e) => e.hasAttribute('data-dxr-auto3d-chip') || e.hasAttribute('data-dxr-auto3d-cover');
  const out = [];
  const walk = (e, path) => {
    if (skip(e)) return;
    const attrs = [...e.attributes].map((a) => {
      if (e.tagName === 'CANVAS' && a.name === 'style') {
        return 'style=' + a.value.split(';').map((x) => x.trim()).filter((x) => x && !/^(will-change|transform)\s*:/.test(x)).join(';');
      }
      return `${a.name}=${a.value}`;
    });
    const cs = getComputedStyle(e), st = {};
    for (let i = 0; i < cs.length; i++) {
      const k = cs[i];
      if (e.tagName === 'CANVAS' && (k === 'will-change' || k === 'transform')) continue;
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
        return { diff: diffSnap(before, after), n: before.length, sb, hostOn, noDev: await page.evaluate(() => typeof window.__dxrAuto3D) };
      },
      check(r, t) {
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
  ];
}

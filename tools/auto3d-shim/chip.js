// DisplayXR auto-3D — the "3D" chip and its menu. PROTOTYPE, not a product.
//
// `function dxrChip(ctl, S)`, a part of the core bundle (build.mjs). It uses only `ctl` (status /
// setEnabled / setRig / setDepth / nudgeFocus / reset / onChange) and the built-ins the sentinel
// snapshotted (`S.intrinsics`: attachShadow, showPopover, elementsFromPoint — risk R4). The core
// calls
//   update(status)   on every notify() (unused: the chip listens through ctl.onChange instead)
//   frame(st)        once per session frame while a canvas is live (placement follows the tile)
//   inspect()        dev.js's __dxrAuto3D.chip(): { root, state, rect, corner, menu }
//
// Design: docs/proposals/auto3d-browser-integration.md §2.2 / §2.6 / §2.7; P0 plan §3. The woven-
// canvas rules it must obey (docs/woven-canvas-rules.md 5, 7, 8), and how each is met — check these
// first when the panel shows the chip woven or soft:
//   - a PLAIN QUAD over the tile: draw-order occlusion composites it as crisp 2D. So NO opacity,
//     filter, backdrop-filter, mix-blend-mode, mask, clip-path or transform anywhere in here (host,
//     wrap, pill, menu). "Fading" is colour alpha only (background-color / border-color transitions).
//   - ALWAYS SMALLER THAN THE TILE: the pill is at most 64x28 CSS px (44 tall under pointer:coarse);
//     the menu opens inside the tile only when it covers < half of it, else outside.
//   - hidden with display:none INSIDE the shadow root; the host popover is shown ONCE and never
//     toggled (a second showPopover() would lift the chip above a page modal opened since).
//   - NO LAYOUT CHANGE: one host on <html>, in the top layer (popover="manual"), position:fixed,
//     0x0, pointer-events:none; nothing is inserted next to the canvas.
//   - NO STOLEN INPUT: only the pill / caret / menu take pointer events; every pointer, mouse, touch,
//     wheel, key and focus event is stopped at the (closed) shadow root in the bubble phase, the pill
//     never takes focus on click (pointerdown default prevented) and a drag that starts on it is
//     captured to it. Page CAPTURE listeners on window / document still see these events (R9).
//   - never over page UI: a corner is used only when elementsFromPoint (the snapshotted built-in) at
//     the box's four corners + centre, skipping our host, first hits the canvas (or its cover).
//
// Lifecycle (view): hidden | offer (outlined; click -> on) | live (green dot; amber while no views or
// ramping; expanded for 3 s from its first appearance) | off (outlined; expanded 5 s after a turn-off).
// The live moment keys off the cover drop OR layerAt + holdMs, whichever comes first (risk R6: with
// nobody seated the cover can stay up indefinitely).
function dxrChip(ctl, S) {
  const I = S.intrinsics;
  const doc = document;
  const TAG = '[dxr-auto3d]';
  const INSET = 8;
  const PILL_W = 38, CARET_W = 22;            // + 2 px border = 40 collapsed, 62 expanded (<= 64)
  const H_FINE = 24, H_COARSE = 44;           // + border, inside 28 / 44
  const LIVE_EXPAND_MS = 3000, OFF_EXPAND_MS = 5000, FS_IDLE_MS = 3000, IDLE_TICK_MS = 500, HIT_EVERY = 30;
  const mq = (q) => { try { return matchMedia(q); } catch (e) { return { matches: false, addEventListener() {} }; } };
  const coarseMq = mq('(pointer: coarse)');
  const now = () => performance.now();

  let s = null;                 // last ctl.status()
  let view = 'hidden';          // what the chip shows
  let host = null, root = null, wrap, pill, dot, caret, menu, live, els = {};
  let corner = null, rectKey = '', frames = 0, canvasObserved = null, ro = null;
  let expandedUntil = 0, expandTimer = 0, hovering = false, menuOpen = false, announced = false;
  let idleTimer = 0, fsIdle = false, fsIdleTimer = 0, rafPending = false;
  let down = null;              // { id, x, y, moved } — a press on the pill / caret

  // ------------------------------------------------------------ DOM (built on first need)
  const CSS = `
.wrap{position:fixed;left:0;top:0;box-sizing:border-box;display:flex;align-items:stretch;height:${H_FINE + 2}px;width:${PILL_W + 2}px;
  margin:0;padding:0;border:1px solid rgba(255,255,255,.35);border-radius:14px;background-color:rgba(16,17,22,.85);
  pointer-events:auto;font:12px/1 system-ui,-apple-system,"Segoe UI",sans-serif;color:#fff;user-select:none;-webkit-user-select:none;
  touch-action:none;cursor:default;transition:background-color .2s linear,border-color .2s linear}
.wrap.hide{display:none}
.wrap.exp{width:${PILL_W + CARET_W + 2}px}
.wrap.outline{background-color:rgba(16,17,22,.45);border-color:rgba(255,255,255,.85)}
button{all:unset;box-sizing:border-box;display:flex;align-items:center;justify-content:center;color:inherit;font:inherit;cursor:pointer}
.pill{width:${PILL_W}px;gap:5px;padding:0 0 0 2px;font-weight:600;letter-spacing:.02em}
.dot{width:6px;height:6px;box-sizing:border-box;border-radius:50%;background-color:#34c759;border:1px solid #34c759}
.dot.a{background-color:#ffb020;border-color:#ffb020}
.dot.o{background-color:transparent;border-color:#fff}
.caret{width:${CARET_W}px;display:none;border-left:1px solid rgba(255,255,255,.25);font-size:10px}
.wrap.exp .caret{display:flex}
.pill:focus-visible,.caret:focus-visible{outline:2px solid #fff;outline-offset:-3px;border-radius:12px}
.menu{position:fixed;inset:auto;left:0;top:0;margin:0;box-sizing:border-box;width:236px;padding:6px 0;overflow:visible;
  border:1px solid rgba(255,255,255,.35);border-radius:8px;background-color:rgb(16,17,22);color:#fff;
  font:12px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;pointer-events:auto;display:none}
.menu.open{display:block}
.menu button{width:100%;justify-content:space-between;padding:6px 12px;text-align:left}
.menu button:focus-visible,.menu button:hover{background-color:rgba(255,255,255,.12)}
.menu [role=menuitemradio]::before{content:"";width:8px;height:8px;margin-right:8px;box-sizing:border-box;border-radius:50%;border:1px solid #fff;flex:none}
.menu [role=menuitemradio][aria-checked=true]::before{background-color:#fff}
.menu [role=menuitemradio]{justify-content:flex-start}
.sw{width:26px;height:14px;box-sizing:border-box;border-radius:7px;border:1px solid #fff;display:flex;align-items:center;padding:0 2px}
.sw::after{content:"";width:8px;height:8px;border-radius:50%;background-color:#fff}
[aria-checked=true] .sw{justify-content:flex-end;background-color:#34c759;border-color:#34c759}
.row{display:flex;align-items:center;gap:8px;padding:4px 12px}
.row>span{flex:none;width:40px;color:rgba(255,255,255,.75)}
.row input{flex:1;min-width:0;margin:0;accent-color:#34c759}
.row output{width:30px;text-align:right;font-variant-numeric:tabular-nums}
.row.focus button{width:auto;flex:1;justify-content:center;padding:4px 0;border:1px solid rgba(255,255,255,.35);border-radius:4px}
.row.focus button[aria-pressed=true]{background-color:rgba(255,255,255,.2)}
.head{padding:4px 12px 2px;color:rgba(255,255,255,.75)}
.sep{height:1px;margin:4px 0;background-color:rgba(255,255,255,.2)}
.menu .hidden{display:none}
.sr{position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden}
@media (pointer:coarse){.wrap{height:${H_COARSE}px;border-radius:22px}}
@media (prefers-reduced-motion:reduce){.wrap{transition:none}}
`;
  const HTML = `
<div class="wrap hide" part="chip">
  <button class="pill" tabindex="-1" aria-pressed="false" aria-haspopup="menu" aria-label="3D view">3D<span class="dot"></span></button>
  <button class="caret" tabindex="-1" aria-haspopup="menu" aria-expanded="false" aria-label="3D view settings">&#x2304;</button>
</div>
<div class="menu" role="menu" aria-label="3D view settings" popover="manual">
  <button role="menuitemcheckbox" tabindex="-1" data-k="site" aria-checked="false">3D on this site<span class="sw"></span></button>
  <div class="sep" role="separator"></div>
  <div class="row" role="group" aria-label="Depth"><span>Depth</span><input type="range" tabindex="-1" min="0.02" max="1" step="0.01" aria-label="Depth" data-k="depth"><output>0.50</output></div>
  <div role="group" aria-label="Style" data-g="style">
    <div class="head" aria-hidden="true">Style</div>
    <button role="menuitemradio" tabindex="-1" data-k="camera" aria-checked="false">Scene camera</button>
    <button role="menuitemradio" tabindex="-1" data-k="display" aria-checked="false">Object on the glass</button>
  </div>
  <div class="row focus" role="group" aria-label="Focus"><span>Focus</span>
    <button role="menuitem" tabindex="-1" data-k="nearer">nearer</button><button role="menuitem" tabindex="-1" data-k="auto">auto</button><button role="menuitem" tabindex="-1" data-k="farther">farther</button>
  </div>
  <div class="sep" role="separator"></div>
  <button role="menuitem" tabindex="-1" data-k="reset">Reset depth and focus</button>
  <button role="menuitem" tabindex="-1" data-k="once">Just this time (don't remember)</button>
</div>
<div class="sr" aria-live="polite"></div>`;

  function build() {
    if (host) return true;
    const de = doc.documentElement;
    if (!de || typeof I.attachShadow !== 'function') return false;
    host = doc.createElement('div');
    host.setAttribute('data-dxr-auto3d-chip', '');
    host.setAttribute('popover', 'manual');
    host.setAttribute('style', 'all:initial!important;position:fixed!important;inset:auto!important;left:0!important;top:0!important;' +
      'width:0!important;height:0!important;margin:0!important;padding:0!important;border:0!important;' +
      'background:transparent!important;overflow:visible!important;display:block!important;pointer-events:none!important');
    try { root = I.attachShadow.call(host, { mode: 'closed' }); } catch (e) { console.warn(TAG, 'chip: attachShadow failed', e); host = null; return false; }
    const style = doc.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
    const t = doc.createElement('template');
    t.innerHTML = HTML;
    root.appendChild(t.content);
    wrap = root.querySelector('.wrap'); pill = root.querySelector('.pill'); dot = root.querySelector('.dot');
    caret = root.querySelector('.caret'); menu = root.querySelector('.menu'); live = root.querySelector('.sr');
    for (const el of root.querySelectorAll('[data-k]')) els[el.getAttribute('data-k')] = el;
    els.out = root.querySelector('output'); els.style = root.querySelector('[data-g=style]');
    wireInput();
    wireMenu();
    de.appendChild(host);
    show();
    for (const [t2, o] of [['scroll', true], ['resize', false]]) window.addEventListener(t2, schedule, { capture: o, passive: true });
    doc.addEventListener('fullscreenchange', onFullscreen);
    doc.addEventListener('pointerdown', (e) => { if (menuOpen && !e.composedPath().includes(host)) closeMenu(false); }, true);
    return true;
  }
  // The ONE show (and a re-show only if the page removed the host: it is then out of the top layer).
  function show() {
    try {
      if (I.showPopover) { I.showPopover.call(host); I.showPopover.call(menu); }
      else host.style.setProperty('z-index', '2147483647', 'important'); // no popover API: plain fixed
    } catch (e) { console.warn(TAG, 'chip: showPopover failed', e); }
    // R9: a page-wide ::backdrop rule would dim the whole page behind a top-layer chip.
    try {
      const b = getComputedStyle(host, '::backdrop');
      const clear = (v) => !v || v === 'none' || v === 'transparent' || v === 'rgba(0, 0, 0, 0)';
      if (!(clear(b.backgroundColor) && clear(b.backgroundImage) && clear(b.backdropFilter) && clear(b.filter))) {
        const sh = new CSSStyleSheet();
        sh.replaceSync('[data-dxr-auto3d-chip]::backdrop{background:transparent!important;backdrop-filter:none!important;filter:none!important}');
        doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sh];
      }
    } catch (e) { /* no ::backdrop support: nothing to neutralise */ }
  }

  // ------------------------------------------------------------ input
  const STOP = ['pointerdown', 'pointerup', 'pointermove', 'pointercancel', 'pointerover', 'pointerout', 'gotpointercapture', 'lostpointercapture',
    'mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout', 'click', 'dblclick', 'auxclick', 'contextmenu', 'wheel',
    'touchstart', 'touchmove', 'touchend', 'touchcancel', 'keydown', 'keyup', 'keypress', 'input', 'change', 'focusin', 'focusout',
    'dragstart', 'selectstart'];
  function wireInput() {
    for (const t of STOP) root.addEventListener(t, (e) => e.stopPropagation(), { passive: t === 'wheel' || t.startsWith('touch') ? true : false });
    // The pill never takes focus from the page, and a drag that starts on it stays on it.
    wrap.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      down = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
      try { e.target.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
    });
    wrap.addEventListener('mousedown', (e) => e.preventDefault());
    wrap.addEventListener('pointermove', (e) => { if (down && e.pointerId === down.id && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) down.moved = true; });
    wrap.addEventListener('pointerenter', () => { hovering = true; render(); });
    wrap.addEventListener('pointerleave', () => { hovering = false; render(); });
    pill.addEventListener('click', (e) => {
      const drag = down && down.moved; down = null;
      if (drag) return; // a drag that ended on the pill is not a click
      e.preventDefault();
      if (view === 'live') ctl.setEnabled(false);
      else if (view === 'off' || view === 'offer') ctl.setEnabled(true);
    });
    caret.addEventListener('click', (e) => { const drag = down && down.moved; down = null; if (!drag) toggleMenu(); });
    pill.addEventListener('contextmenu', (e) => { e.preventDefault(); openMenu(); });
    caret.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ------------------------------------------------------------ the menu
  const items = () => [...menu.querySelectorAll('button,input')].filter((el) => el.offsetParent !== null || el.getClientRects().length);
  function wireMenu() {
    menu.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('button[data-k]');
      if (!b) return;
      const k = b.getAttribute('data-k'), st = s || ctl.status();
      if (k === 'site') ctl.setEnabled(!st.enabled);
      else if (k === 'camera' || k === 'display') ctl.setRig(k);
      else if (k === 'nearer') ctl.nudgeFocus(-1);
      else if (k === 'auto') ctl.nudgeFocus(0);
      else if (k === 'farther') ctl.nudgeFocus(+1);
      else if (k === 'reset') ctl.reset();
      else if (k === 'once') { closeMenu(true); ctl.setEnabled(!st.enabled, { remember: false }); }
    });
    // Live while dragging, saved once when let go.
    els.depth.addEventListener('input', () => ctl.setDepth(+els.depth.value, { remember: false }));
    els.depth.addEventListener('change', () => ctl.setDepth(+els.depth.value));
    menu.addEventListener('keydown', (e) => {
      const list = items(), i = list.indexOf(root.activeElement);
      const go = (j) => { const el = list[(j + list.length) % list.length]; if (el) el.focus(); };
      switch (e.key) {
        case 'ArrowDown': go(i + 1); break;
        case 'ArrowUp': go(i - 1); break;
        case 'Home': go(0); break;
        case 'End': go(list.length - 1); break;
        case 'Escape': closeMenu(true); break;
        case 'Tab': closeMenu(true); break;
        default: return; // Enter / Space click natively; Left / Right move the slider natively
      }
      e.preventDefault();
    });
  }
  function toggleMenu() { if (menuOpen) closeMenu(true); else openMenu(); }
  function openMenu() {
    if (view === 'hidden' || !host) return;
    menuOpen = true;
    caret.setAttribute('aria-expanded', 'true');
    syncMenu();
    menu.classList.add('open');
    placeMenu();
    render();
    const first = items()[0];
    if (first) first.focus({ preventScroll: true });
  }
  function closeMenu(refocus) {
    if (!menuOpen) return;
    menuOpen = false;
    menu.classList.remove('open');
    caret.setAttribute('aria-expanded', 'false');
    if (refocus && view !== 'hidden') pill.focus({ preventScroll: true });
    else if (root.activeElement && root.activeElement.blur) root.activeElement.blur();
    render();
  }
  function syncMenu() {
    if (!s) return;
    els.site.setAttribute('aria-checked', String(!!s.enabled));
    if (root.activeElement !== els.depth) els.depth.value = String(s.depth);
    els.out.textContent = (+s.depth).toFixed(2);
    els.style.classList.toggle('hidden', !s.rigSupported);
    els.camera.setAttribute('aria-checked', String(s.rig === 'camera'));
    els.display.setAttribute('aria-checked', String(s.rig === 'display'));
    els.auto.setAttribute('aria-pressed', String(s.convScale === 1));
    els.once.textContent = `${s.enabled ? 'Off' : 'On'} just this time (don't remember)`;
  }
  // Inside the tile (8 px inset) when it covers less than half of it, else outside the tile.
  function placeMenu() {
    if (!menuOpen || !s || !s.canvas) return;
    const r = s.canvas.getBoundingClientRect(), w = wrap.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    const vw = doc.documentElement.clientWidth || innerWidth, vh = doc.documentElement.clientHeight || innerHeight;
    const right = corner === 'tr' || corner === 'br', top = corner === 'tr' || corner === 'tl';
    let x = right ? w.right - mw : w.left, y = top ? w.bottom + 4 : w.top - 4 - mh;
    const inside = x >= r.left + INSET && x + mw <= r.right - INSET && y >= r.top + INSET && y + mh <= r.bottom - INSET &&
      mw * mh < 0.5 * r.width * r.height;
    if (!inside) {
      const fits = (a, b) => a >= 0 && b >= 0 && a + mw <= vw && b + mh <= vh;
      const xs = right ? r.right - mw : r.left;
      const opts = [[xs, r.bottom + 4], [xs, r.top - 4 - mh], [r.right + 4, w.top], [r.left - 4 - mw, w.top]];
      const hit = opts.find(([a, b]) => fits(a, b));
      if (hit) [x, y] = hit;
      else { x = Math.min(Math.max(0, x), vw - mw); y = Math.min(Math.max(0, y), vh - mh); }
    }
    setPx(menu, 'left', x);
    setPx(menu, 'top', y);
  }

  // ------------------------------------------------------------ state -> view
  function viewOf(st) {
    if (!st || !st.canvas) return 'hidden';
    // 'converting' + waiting: live on the layer, but no stereo frame yet (nobody tracked): amber pill.
    if (st.state === 'live' || st.waiting) {
      if (!st.enabled) return 'off'; // turning off: fading out / staged under the out-cover
      if (st.coverUp && !(st.layerAt && now() >= st.layerAt + st.holdMs)) return 'hidden'; // R6
      return 'live';
    }
    if (st.state === 'off') return 'off';
    if (st.state === 'offer') return 'offer';
    return 'hidden'; // converting, idle, flat, standdown, optout, guard
  }
  function refresh(st) {
    s = st;
    const prev = view, next = viewOf(st);
    view = next;
    if (next !== prev) {
      if (next === 'live') {
        expandFor(LIVE_EXPAND_MS);
        if (!announced && build()) { announced = true; live.textContent = '3D view on'; }
      } else if (next === 'off' && prev === 'live') expandFor(OFF_EXPAND_MS);
      else if (next === 'hidden') { expandedUntil = 0; if (menuOpen) closeMenu(false); }
      rectKey = ''; // re-run the hit test for the new state
    }
    if (next !== 'hidden' && !build()) return;
    observe(next !== 'hidden' ? st.canvas : null);
    idle(next === 'offer' || next === 'off'); // no session loop: poll the placement
    if (menuOpen) syncMenu();
    render();
    place();
  }
  function expandFor(ms) {
    expandedUntil = now() + ms;
    clearTimeout(expandTimer);
    expandTimer = setTimeout(render, ms + 20);
  }
  // Per-frame callers: write only what changed (no style invalidation on a steady frame).
  const setA = (el, k, v) => { if (el.getAttribute(k) !== v) el.setAttribute(k, v); };
  const setPx = (el, k, v) => { const t = Math.round(v) + 'px'; if (el.style[k] !== t) el.style[k] = t; };
  function render() {
    if (!host) return;
    const vis = view !== 'hidden' && corner !== null && !fsIdle;
    wrap.classList.toggle('hide', !vis);
    if (!vis) return;
    const on = view === 'live';
    wrap.classList.toggle('outline', !on);
    wrap.classList.toggle('exp', menuOpen || hovering || now() < expandedUntil);
    setA(dot, 'class', 'dot ' + (!on ? 'o' : s.haveViews && !s.ramping ? 'g' : 'a'));
    setA(pill, 'aria-pressed', String(on));
    setA(pill, 'aria-label', on ? '3D view: on. Turn off for this site' : view === 'offer' ? '3D view available. Turn on for this site' : '3D view: off. Turn on for this site');
  }

  // ------------------------------------------------------------ placement + hit test
  const boxH = () => (coarseMq.matches ? H_COARSE : H_FINE) + 2;
  const BOX_W = PILL_W + CARET_W + 2; // hit-test the EXPANDED box: expanding never grows over page UI
  function boxAt(c, r) {
    const h = boxH();
    const x = c === 'tr' || c === 'br' ? r.right - INSET - BOX_W : r.left + INSET;
    const y = c === 'tr' || c === 'tl' ? r.top + INSET : r.bottom - INSET - h;
    return { x, y, w: BOX_W, h };
  }
  function clearAt(b, cv, cover) {
    const pts = [[b.x + 1, b.y + 1], [b.x + b.w - 1, b.y + 1], [b.x + 1, b.y + b.h - 1], [b.x + b.w - 1, b.y + b.h - 1], [b.x + b.w / 2, b.y + b.h / 2]];
    for (const [x, y] of pts) {
      let first = null;
      for (const el of I.elementsFromPoint.call(doc, x, y)) { if (el !== host) { first = el; break; } }
      if (!first || (first !== cv && first !== cover)) return false;
    }
    return true;
  }
  function place() {
    if (!host) return;
    if (view === 'hidden' || !s || !s.canvas || !s.canvas.isConnected) { if (corner !== null) { corner = null; render(); } return; }
    if (!host.isConnected) { doc.documentElement.appendChild(host); show(); }
    const r = s.canvas.getBoundingClientRect();
    const key = `${r.left},${r.top},${r.width},${r.height},${innerWidth},${innerHeight},${coarseMq.matches}`;
    if (key !== rectKey || frames % HIT_EVERY === 0) {
      rectKey = key;
      const was = corner;
      corner = null;
      if (r.width > 2 * INSET + BOX_W && r.height > 2 * INSET + boxH()) {
        for (const c of ['tr', 'br', 'tl', 'bl']) if (clearAt(boxAt(c, r), s.canvas, s.cover)) { corner = c; break; }
      }
      if (corner !== was) render();
    }
    if (corner === null) return;
    const b = boxAt(corner, r);
    // Right corners keep their right edge when the pill expands / collapses.
    const w = wrap.classList.contains('exp') ? BOX_W : PILL_W + 2;
    const x = corner === 'tr' || corner === 'br' ? b.x + b.w - w : b.x;
    setPx(wrap, 'left', x);
    setPx(wrap, 'top', b.y);
    if (menuOpen) placeMenu();
  }
  function schedule() {
    if (rafPending || view === 'hidden') return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; rectKey = ''; place(); });
  }
  function observe(cv) {
    if (cv === canvasObserved) return;
    if (ro) ro.disconnect();
    canvasObserved = cv;
    if (!cv || typeof ResizeObserver !== 'function') return;
    if (!ro) ro = new ResizeObserver(schedule);
    ro.observe(cv);
  }
  function idle(onoff) {
    if (onoff && !idleTimer) idleTimer = setInterval(() => { frames = 0; refresh(ctl.status()); }, IDLE_TICK_MS);
    else if (!onoff && idleTimer) { clearInterval(idleTimer); idleTimer = 0; }
  }

  // ------------------------------------------------------------ fullscreen: hide after 3 s idle
  // NOTE: a fullscreen element enters the top layer AFTER our host, so it paints over the chip; the
  // hit test then hides it anyway. Kept for a browser that lifts the chip (open point, see report).
  const fsOurs = () => { const f = doc.fullscreenElement; return !!(f && s && s.canvas && (f === s.canvas || f.contains(s.canvas))); };
  function onPointerActivity() {
    if (!fsOurs()) return;
    if (fsIdle) { fsIdle = false; render(); }
    clearTimeout(fsIdleTimer);
    fsIdleTimer = setTimeout(() => { if (fsOurs()) { fsIdle = true; render(); } }, FS_IDLE_MS);
  }
  function onFullscreen() {
    if (fsOurs()) { window.addEventListener('pointermove', onPointerActivity, { capture: true, passive: true }); onPointerActivity(); }
    else { window.removeEventListener('pointermove', onPointerActivity, true); clearTimeout(fsIdleTimer); if (fsIdle) { fsIdle = false; render(); } }
    schedule();
  }

  ctl.onChange(() => refresh(ctl.status()));
  return {
    update() { /* the chip listens through ctl.onChange */ },
    // Once per session frame while live: the tile may move with the page every frame.
    frame() {
      frames++;
      refresh(ctl.status());
    },
    inspect() {
      const r = host && !wrap.classList.contains('hide') ? wrap.getBoundingClientRect() : null;
      return {
        root, host, state: view, corner, menu: menuOpen,
        rect: r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null,
        menuRect: menuOpen ? (({ left, top, width, height }) => ({ left, top, width, height }))(menu.getBoundingClientRect()) : null,
      };
    },
  };
}

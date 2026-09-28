// DisplayXR auto-3D — developer surface. PROTOTYPE, not a product.
//
// `function dxrDev(core, ctl)`, a part of the core bundle (build.mjs), run only when cfg.dev (the
// dev extension, or the browser's developer switch). Moved from core.js v0.4.0 unchanged in
// behaviour: the HUD (bottom left), the Ctrl+Alt hotkeys, `window.__dxrAuto3D` (state(), probe(),
// set()). The harness (test/run.mjs) reads all three, so their text and shape stay as they were.
// Settings go through `ctl` (the same controller the chip uses); the HUD's own on/off is saved with
// the host's `save` as a dev-only `hud` field.
function dxrDev(core, ctl) {
  const { VERSION, HAS_RIG, T, site, meta, tracked, engines, now, desc, realW, realH, rigMode, depthOf, convSource, rampK, flatNote } = core;
  let hudOn = core.cfg.hud !== false;

  // ------------------------------------------------------------ HUD + hotkeys
  let hudEl = null, hudUntil = 0, hudPending = false;
  function hud(flash) {
    if (flash) hudUntil = now() + 2500;
    const st = core.owner, foreign = core.foreign, enabled = core.on();
    const busy = st && (st.active || st.pending || st.armed);
    const flat = !busy && !foreign && enabled ? flatNote() : null;
    // A stand-down stays on the HUD like a flat reason does: the tester has to see that the page,
    // not the shim, owns inline-3D (it was only drawn inside a hotkey flash before).
    if (!hudOn || !(busy || flat || foreign || now() < hudUntil)) { if (hudEl) { hudEl.remove(); hudEl = null; } return; }
    if (!document.body) { if (!hudPending) { hudPending = true; document.addEventListener('DOMContentLoaded', () => { hudPending = false; hud(); }, { once: true }); } return; }
    if (!hudEl) {
      hudEl = document.createElement('div');
      hudEl.setAttribute('data-dxr-auto3d-hud', '');
      Object.assign(hudEl.style, {
        position: 'fixed', left: '8px', bottom: '8px', zIndex: '2147483647', font: '12px/1.4 monospace', color: '#fff',
        background: 'rgba(0,0,0,.72)', padding: '4px 8px', borderRadius: '4px', pointerEvents: 'none', whiteSpace: 'pre',
      });
      document.body.appendChild(hudEl);
    }
    let text;
    if (!enabled) text = 'DXR auto-3D: OFF for this site  (Ctrl+Alt+3)';
    else if (st && st.active) {
      const s = st.stats;
      text = `DXR auto-3D ● ${HAS_RIG ? rigMode() : 'display'} rig · depth ${depthOf().toFixed(2)} · conv ${(st.conv.d * site.convScale).toPrecision(3)} (${convSource(st)})` +
        ` · 3D ${s.stereo} · flat ${s.flat} · replay ${s.replays}` +
        (st.nd ? ' · no 3D display for this window' : st.haveViews ? (st.eyesOn ? '' : ' · eyes lost') : ' · waiting for eyes');
    } else if (busy) text = 'DXR auto-3D: converting…';
    else if (foreign) text = `DXR auto-3D: standing down (${foreign})`;
    else if (flat) text = `DXR auto-3D: 2D (${flat.engine}) — ${flat.flatReason}`;
    else text = `DXR auto-3D: ON (${rigMode()} rig) — no ${engines.join(' / ') || '3D'} scene converted yet`;
    hudEl.textContent = text;
  }
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey && e.altKey) || e.shiftKey || e.metaKey) return;
    let hit = true;
    switch (e.code) {
      case 'Digit3': ctl.setEnabled(!core.on()); break;
      case 'KeyP': ctl.setRig(rigMode() === 'camera' ? 'display' : 'camera'); break;
      case 'Equal': ctl.setDepth(depthOf() * 1.25); break; // the ACTIVE rig's depth (joint ipd + parallax on both rigs)
      case 'Minus': ctl.setDepth(depthOf() / 1.25); break;
      case 'Digit0': ctl.nudgeFocus(+1); break;
      case 'Digit9': ctl.nudgeFocus(-1); break;
      case 'Digit8': ctl.reset(); break; // the active rig's default
      case 'KeyD': hudOn = !hudOn; core.save({ hud: hudOn }); break;
      default: hit = false;
    }
    if (hit) { e.preventDefault(); e.stopImmediatePropagation(); hud(true); }
  }, true);

  // ------------------------------------------------------------ diagnostics
  window.__dxrAuto3D = {
    version: VERSION,
    get cfg() { return { ...T, ...site, enabled: core.on(), hud: hudOn }; },
    set(k, v) {
      if (k === 'enabled') ctl.setEnabled(v);
      else if (k === 'depth') ctl.setDepth(+v); // the active rig's
      else if (k === 'rig') ctl.setRig(v);
      else if (k === 'convScale') { site.convScale = core.clamp(+v || 1, core.CONV_SCALE_MIN, core.CONV_SCALE_MAX); core.save({ convScale: site.convScale }); }
      else if (k === 'hud') { hudOn = !!v; core.save({ hud: hudOn }); }
      else T[k] = v;
      hud(true);
    },
    state() {
      const renderers = [];
      for (const w of tracked) {
        const st = w.deref();
        if (!st) continue;
        const rect = st.canvas.getBoundingClientRect();
        const d = st.ad.describe(st);
        renderers.push({
          engine: st.engine,
          canvas: desc(st.canvas),
          css: [Math.round(rect.width), Math.round(rect.height)],
          page: d.page,
          real: [realW(st.canvas), realH(st.canvas)],
          eye: st.R ? [st.R.eyeW, st.R.eyeH] : null,
          active: st.active, pending: !!(st.pending || st.armed), haveViews: st.haveViews, eyesOn: !!st.eyesOn, noDisplay: !!(st.nd || st.noDisplay),
          convergence: st.conv.d, convergenceSource: convSource(st), convergenceVia: st.conv.via,
          rig: st.active ? JSON.parse(JSON.stringify(st.rig)) : null, releasing: !!st.releasing,
          rampK: st.active ? rampK(st) : null, ramping: !!st.ramp, drawnAt: st.drawnAt || null,
          why: st.lastWhy, flatReason: st.flatReason, stats: { ...st.stats },
          ...(d.extra || {}),
        });
      }
      return { version: VERSION, engines: engines.slice(), ...meta, enabled: core.on(), foreign: core.foreign, rigSupported: HAS_RIG, rigMode: rigMode(), depth: depthOf(), depths: { camera: depthOf('camera'), display: depthOf('display') }, renderers };
    },
    // What the live layer's display API answers (diagnostics only).
    async probe() {
      const L = core.owner && core.owner.layer;
      if (!L) return { layer: false };
      const ask = async (name) => {
        if (typeof L[name] !== 'function') return 'absent';
        try { return await Promise.race([L[name](), new Promise((r) => setTimeout(() => r('timeout 2s'), 2000))]); }
        catch (e) { return 'rejected: ' + (e && (e.name + ' ' + e.message)); }
      };
      return { layer: true, displayInfo: await ask('getDisplayInfo'), renderingModes: await ask('getRenderingModes') };
    },
    // The chip, for the harness: { root (its closed shadow root), host, state, corner, menu, rect, menuRect }.
    chip: () => (core.chip && core.chip.inspect ? core.chip.inspect() : null),
  };
  return { hud };
}

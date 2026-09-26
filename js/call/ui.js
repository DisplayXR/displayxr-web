// call/ui.js — the SDK-drawn call chrome: lobby, tiles' badges and state plates, the bottom bar,
// the invite panel, the "View in 3D" banner. DOM + CSS only; the call module drives it.
//
// The overlay contract (docs/authoring-inline-3d.md, docs/woven-canvas-rules.md) is the same one
// the player obeys, and it shapes every rule below:
//
//  1. Chrome ON a tile (the 3D/2D badge, the "Reconnecting…" plate) is a PARTIAL region — a small
//     pill, never a plate congruent with the tile (it would match the canvas's own quad on a
//     legacy browser and take the tile out of the weave). The bottom bar and self view live in a
//     footer BELOW the grid, over no tile at all.
//  2. NO `backdrop-filter`. The near-solid `--dxr-shell` (rgba(16,17,22,.92)) is the substitute.
//  3. Promotion is `will-change: transform`. No CSS filter / opacity / border-radius / shadow on a
//     woven canvas OR ANY ANCESTOR of one — the tile, the grid and the host stay visually bare.
//     A speaking highlight is a separate bar UNDER the stage, not an outline around it.
//  4. Hidden chrome is `display: none`, never `opacity: 0`.
//  5. The one full-tile element is the opaque COVER held until `handle.firstWoven` (rule 5 of the
//     woven-canvas rules), cut — never faded — when it resolves.

/** Named accents, shared with ./player (same names, same colours). */
export const CALL_ACCENTS = Object.freeze({
  azure: '#4da3ff',
  violet: '#9b7bff',
  magenta: '#ff4fa3',
  sunset: '#ff7a45',
  amber: '#ffc23d',
  lime: '#9be15d',
  mint: '#35e0b0',
  ice: '#8fe3ff',
});
export const resolveCallAccent = (a) => (typeof a === 'string' && CALL_ACCENTS[a.toLowerCase()]) || a;

const STYLE_ID = 'dxr-call-style';
const CSS = `
.dxr-call-host{--dxr-accent:#4da3ff;--dxr-ink:#fff;--dxr-shell:rgba(16,17,22,.92);--dxr-danger:#ff5a5f;
  display:flex;flex-direction:column;gap:12px;color:var(--dxr-ink);
  font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}
.dxr-call-host *{box-sizing:border-box;}
.dxr-call-hidden{display:none !important;}
.dxr-call-banner{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 14px;border-radius:10px;
  background:var(--dxr-shell);border:1px solid rgba(255,255,255,.12);font-size:13px;}
.dxr-call-banner a{color:var(--dxr-accent);font-weight:600;}
/* ── grid: bare boxes, nothing that makes a render surface ── */
.dxr-call-grid{display:grid;gap:10px;grid-template-columns:1fr;}
.dxr-call-grid[data-n="2"],.dxr-call-grid[data-n="3"]{grid-template-columns:1fr 1fr;}
.dxr-call-grid[data-layout="speaker"]{grid-template-columns:repeat(3,1fr);}
.dxr-call-grid[data-layout="speaker"] .dxr-call-tile--main{grid-column:1/-1;}
.dxr-call-grid[data-layout="speaker"][data-n="1"]{grid-template-columns:1fr;}
.dxr-call-tile{position:relative;min-width:0;}
.dxr-call-stage{position:relative;background:#000;}
.dxr-call-stage>canvas{display:block;width:100%;height:100%;}
.dxr-call-talk{height:3px;margin-top:4px;background:transparent;}
.dxr-call-tile--speaking .dxr-call-talk{background:var(--dxr-accent);}
/* ── partial overlays on a tile ── */
.dxr-call-badge{position:absolute;left:8px;top:8px;z-index:2;display:flex;align-items:center;gap:6px;
  padding:3px 8px;border-radius:99px;background:var(--dxr-shell);font-size:11px;font-weight:600;
  letter-spacing:.4px;will-change:transform;pointer-events:none;}
.dxr-call-badge b{font-weight:800;color:var(--dxr-accent);}
.dxr-call-badge svg{width:13px;height:13px;fill:var(--dxr-danger);}
.dxr-call-state{position:absolute;left:50%;top:50%;z-index:2;transform:translate(-50%,-50%);max-width:70%;
  padding:8px 14px;border-radius:99px;background:var(--dxr-shell);font-size:13px;text-align:center;
  will-change:transform;pointer-events:none;}
.dxr-call-cover{position:absolute;inset:0;z-index:1;background:#000;}
/* ── empty room / lobby ── */
.dxr-call-panel{padding:18px;border-radius:12px;background:var(--dxr-shell);border:1px solid rgba(255,255,255,.1);}
.dxr-call-panel h3{margin:0 0 6px;font-size:17px;}
.dxr-call-panel p{margin:0 0 12px;opacity:.75;}
.dxr-call-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;}
.dxr-call-btn{appearance:none;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:inherit;
  font:600 13px/1 system-ui,-apple-system,"Segoe UI",sans-serif;padding:9px 14px;border-radius:9px;cursor:pointer;}
.dxr-call-btn:hover{background:rgba(255,255,255,.16);}
.dxr-call-btn:focus-visible{outline:2px solid var(--dxr-accent);outline-offset:2px;}
.dxr-call-btn--primary{background:var(--dxr-accent);border-color:var(--dxr-accent);color:#07111d;}
.dxr-call-btn--primary:hover{background:var(--dxr-accent);}
.dxr-call-btn--danger{background:var(--dxr-danger);border-color:var(--dxr-danger);color:#fff;}
.dxr-call-select{font:inherit;color:inherit;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.18);
  border-radius:8px;padding:7px 9px;max-width:260px;}
.dxr-call-invite{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap;}
.dxr-call-invite input{flex:1 1 240px;min-width:0;font:12px ui-monospace,Menlo,monospace;color:inherit;
  background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:8px;}
.dxr-call-invite canvas{width:132px;height:132px;image-rendering:pixelated;background:#fff;}
/* ── footer: self view + bar, BELOW the grid (over no tile) ── */
.dxr-call-foot{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;}
.dxr-call-self{width:200px;flex:none;}
.dxr-call-host--lobby .dxr-call-self{width:min(560px,100%);}
.dxr-call-self .dxr-call-badge b{color:var(--dxr-ink);}
.dxr-call-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 10px;border-radius:14px;
  background:var(--dxr-shell);border:1px solid rgba(255,255,255,.1);will-change:transform;}
.dxr-call-host--lobby .dxr-call-bar{display:none;}
.dxr-call-ib{appearance:none;border:0;width:40px;height:40px;border-radius:50%;padding:9px;cursor:pointer;
  background:rgba(255,255,255,.1);color:var(--dxr-ink);}
.dxr-call-ib:hover{background:rgba(255,255,255,.2);}
.dxr-call-ib:focus-visible{outline:2px solid var(--dxr-accent);outline-offset:2px;}
.dxr-call-ib svg{width:100%;height:100%;fill:currentColor;display:block;}
.dxr-call-ib[aria-pressed="true"]{background:var(--dxr-ink);color:#111;}
.dxr-call-ib--leave{background:var(--dxr-danger);width:52px;border-radius:20px;}
.dxr-call-ib--leave:hover{background:var(--dxr-danger);}
.dxr-call-depth{display:flex;align-items:center;gap:6px;padding:0 8px;font-size:12px;opacity:.9;}
.dxr-call-depth input{width:110px;accent-color:var(--dxr-accent);}
.dxr-call-note{font-size:12px;opacity:.65;}
`;

export function injectCallStyle(doc = document) {
  if (doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  (doc.head || doc.documentElement).appendChild(s);
}

const P = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
export const ICONS = {
  mic: P('M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11z'),
  micOff: P('M19 11h-2a5 5 0 0 1-.4 1.97l1.47 1.47A6.96 6.96 0 0 0 19 11zM15 11V5a3 3 0 0 0-5.94-.6L15 10.34zM4.27 3 3 4.27l6 6V11a3 3 0 0 0 4.52 2.59l1.46 1.46A5 5 0 0 1 7 11H5a7 7 0 0 0 6 6.92V21h2v-3.08a6.9 6.9 0 0 0 3.02-1.14L19.73 21 21 19.73z'),
  cam: P('M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11z'),
  camOff: P('M21 6.5l-4 4V7a1 1 0 0 0-1-1H9.82L21 17.18zM3.27 2 2 3.27 4.73 6H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73z'),
  link: P('M3.9 12a3.1 3.1 0 0 1 3.1-3.1h4V7H7a5 5 0 0 0 0 10h4v-1.9H7A3.1 3.1 0 0 1 3.9 12zM8 13h8v-2H8zm9-6h-4v1.9h4a3.1 3.1 0 0 1 0 6.2h-4V17h4a5 5 0 0 0 0-10z'),
  leave: P('M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85a1 1 0 0 1-1.41-.02L.29 13.08a1 1 0 0 1 0-1.41C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67a1 1 0 0 1 0 1.41l-2.48 2.48a1 1 0 0 1-1.41.02 11.3 11.3 0 0 0-2.66-1.85 1 1 0 0 1-.56-.9v-3.1A15.3 15.3 0 0 0 12 9z'),
  mutedSmall: P('M19 11h-2a5 5 0 0 1-.4 1.97l1.47 1.47A6.96 6.96 0 0 0 19 11zM15 11V5a3 3 0 0 0-5.94-.6L15 10.34zM4.27 3 3 4.27l6 6V11a3 3 0 0 0 4.52 2.59l1.46 1.46A5 5 0 0 1 7 11H5a7 7 0 0 0 6 6.92V21h2v-3.08a6.9 6.9 0 0 0 3.02-1.14L19.73 21 21 19.73z'),
};

/** `el('div', {class: 'x'}, [children])` — a tiny builder, attributes as properties or attrs. */
export function el(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k in n && typeof v !== 'string') n[k] = v;
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return n;
}

export const show = (n, on) => n && n.classList.toggle('dxr-call-hidden', !on);

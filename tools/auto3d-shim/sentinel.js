// DisplayXR auto-3D — the sentinel. PROTOTYPE, not a product.
//
// `function dxrSentinel(cfg, cap)`: the only part evaluated in every frame at document start
// (dist/auto3d-sentinel.js). The host calls it with the frozen per-frame `cfg` and the capability
// object `cap` (see core.js's header); neither is ever put on `window`.
//
// What it owns:
//   - the DisplayXR check (inert anywhere else) and the double-injection marker: a value-only
//     `window[Symbol.for('dxr.auto3d')] = true`; the first injector wins (a dev extension and the
//     product injector in one browser);
//   - `S.intrinsics`: browser built-ins snapshotted before any page script can patch them (risk
//     R4 — the core and the chip may load late);
//   - the `navigator.xr.requestSession` wrapper (risk R3): a page that asks for inline-3d /
//     immersive-* itself owns XR, and the core must hear of it even when the request comes first;
//   - (next slice) the engine detection and a LAZY core: `cap.loadCore()` only once an engine is
//     found. In this slice the core loads EAGERLY, at once, and the adapters keep their v0.4
//     detection;
//   - a USER block (cfg.decision === 'block', outside dev): detect-only. The core is NEVER loaded;
//     once an engine is detected the sentinel reports { status: 'off', engine } once, so the
//     browser can offer a re-enable (reportOff below; the detection that calls it is the next
//     slice's). In dev the core still loads: the HUD and Ctrl+Alt+3 need it.
function dxrSentinel(cfg, cap) {
  const TAG = '[dxr-auto3d]';
  const MARK = Symbol.for('dxr.auto3d');
  if (window[MARK]) return; // another injector armed this document first
  if (typeof window.XRDisplayLayer !== 'function' || !navigator.xr) return; // not the DisplayXR Browser: inert
  try { Object.defineProperty(window, MARK, { value: true }); } catch (e) { return; }

  // ------------------------------------------------------------ intrinsics (R4)
  const gopd = (o, k) => { const d = Object.getOwnPropertyDescriptor(o, k); return d ? Object.freeze(d) : null; };
  const intrinsics = Object.freeze({
    attachShadow: Element.prototype.attachShadow,
    showPopover: HTMLElement.prototype.showPopover || null,
    elementsFromPoint: Document.prototype.elementsFromPoint,
    canvasWidth: gopd(HTMLCanvasElement.prototype, 'width'),
    canvasHeight: gopd(HTMLCanvasElement.prototype, 'height'),
    elementId: gopd(Element.prototype, 'id'),
  });

  // ------------------------------------------------------------ navigator.xr: yield to the page (R3)
  // Our own requests go straight to the captured original (S.xrRequest), so the wrapper only ever
  // sees the page's (or the immersive shim's, which reaches the real XRSystem through this object).
  let foreign = null;
  const foreignCbs = [];
  const xrObj = navigator.xr;
  const xrReqOrig = xrObj.requestSession;
  const xrRequest = (mode, init) => xrReqOrig.call(xrObj, mode, init);
  try {
    xrObj.requestSession = function (mode, init) {
      if (mode === 'inline-3d' || mode === 'immersive-vr' || mode === 'immersive-ar') {
        const reason = `the page requested '${mode}'`;
        if (!foreign) foreign = reason;
        for (const cb of foreignCbs.slice()) { try { cb(reason); } catch (e) { /* the core logs its own */ } }
      }
      return xrReqOrig.call(xrObj, mode, init);
    };
  } catch (e) { console.warn(TAG, 'could not watch navigator.xr.requestSession — SDK pages may conflict', e); }

  const S = Object.freeze({
    devtools: null,               // (next slice) the __THREE_DEVTOOLS__ EventTarget the sentinel owns
    intrinsics,
    xrRequest,
    foreign: () => foreign,       // why the page owns XR in this document, or null
    onForeign(cb) { foreignCbs.push(cb); },
    optedOut: () => false,        // (next slice) <meta name="displayxr-auto3d" content="off">
    disarm() {},                  // (next slice) remove the per-instance traps
  });

  // ------------------------------------------------------------ user block: detect-only
  let offReported = false;
  const reportOff = (engine) => {
    if (offReported) return;
    offReported = true;
    try { cap.report({ status: 'off', engine }); } catch (e) { /* ignore */ }
  };
  if (cfg.decision === 'block' && !cfg.dev) { void reportOff; return; }

  // ------------------------------------------------------------ the core (eager in this slice)
  let make = null;
  try { make = cap.loadCore(); } catch (e) { console.warn(TAG, 'the core could not be loaded', e); return; }
  if (typeof make !== 'function') return;
  make(cfg, cap, S);
}

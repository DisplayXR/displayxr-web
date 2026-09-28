// DisplayXR auto-3D 0.5.0 — built by tools/auto3d-shim/build.mjs from displayxr-web. Do not edit: fix the source, rebuild, re-vendor.
(function (cfg, cap) {
'use strict';
function dxrSentinel(cfg, cap) {
  const TAG = '[dxr-auto3d]';
  const MARK = Symbol.for('dxr.auto3d');
  if (window[MARK]) return; // another injector armed this document first
  if (typeof window.XRDisplayLayer !== 'function' || !navigator.xr) return; // not the DisplayXR Browser: inert
  try { Object.defineProperty(window, MARK, { value: true }); } catch (e) { return; }

  const gopd = (o, k) => { const d = Object.getOwnPropertyDescriptor(o, k); return d ? Object.freeze(d) : null; };
  const intrinsics = Object.freeze({
    attachShadow: Element.prototype.attachShadow,
    showPopover: HTMLElement.prototype.showPopover || null,
    elementsFromPoint: Document.prototype.elementsFromPoint,
    canvasWidth: gopd(HTMLCanvasElement.prototype, 'width'),
    canvasHeight: gopd(HTMLCanvasElement.prototype, 'height'),
    elementId: gopd(Element.prototype, 'id'),
  });

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

  let offReported = false;
  const reportOff = (engine) => {
    if (offReported) return;
    offReported = true;
    try { cap.report({ status: 'off', engine }); } catch (e) { /* ignore */ }
  };
  if (cfg.decision === 'block' && !cfg.dev) { void reportOff; return; }

  let make = null;
  try { make = cap.loadCore(); } catch (e) { console.warn(TAG, 'the core could not be loaded', e); return; }
  if (typeof make !== 'function') return;
  make(cfg, cap, S);
}
return dxrSentinel(cfg, cap);
})

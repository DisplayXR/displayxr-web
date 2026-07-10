// displayxr-inline3d.js — a thin, dependency-free helper over the DisplayXR Browser's
// `inline-3d` WebXR surface. Feature-detects, opens a sensorless inline session, binds an
// XRDisplayLayer to your canvas, and drives a per-frame render callback with the two
// off-axis eye views the session reports (the "look-around"). Returns a handle you can
// close(). If inline-3d is unavailable (any normal browser / a 2D monitor), it resolves to
// { supported:false } and you should fall back to a plain mono render — the page still works.
//
// Usage:
//   import { startInline3D } from '../js/displayxr-inline3d.js';
//   const xr = await startInline3D(canvas, {
//     onFrame: (views, layer, frame) => {
//       for (const v of views) {
//         const vp = layer.getViewport(v);              // {x,y,width,height} into the canvas
//         // set your camera from v.projectionMatrix + v.transform.matrix, render into vp
//       }
//     },
//   });
//   if (!xr.supported) { /* mono fallback */ }

export async function isInline3DSupported() {
  if (!('xr' in navigator) || !navigator.xr) return false;
  try {
    // XRDisplayLayer is gated by the DisplayXRInline3D RuntimeEnabledFeature; both it and
    // session support must be present.
    if (typeof window.XRDisplayLayer !== 'function') return false;
    return await navigator.xr.isSessionSupported('inline-3d');
  } catch {
    return false;
  }
}

export async function startInline3D(canvas, { onFrame, referenceSpace = 'viewer' } = {}) {
  const supported = await isInline3DSupported();
  if (!supported) return { supported: false };

  let session;
  try {
    session = await navigator.xr.requestSession('inline-3d');
  } catch (e) {
    return { supported: false, error: e };
  }

  // Bind the canvas — this is what opts the element into the OS weave. The layer also
  // reports the canvas's live rect to the compositor each frame, and gives us the per-eye
  // side-by-side viewports via getViewport(view).
  const layer = new XRDisplayLayer(session, canvas);
  const refSpace = await session.requestReferenceSpace(referenceSpace);

  let running = true;
  const loop = (t, frame) => {
    if (!running) return;
    session.requestAnimationFrame(loop);
    const pose = frame.getViewerPose(refSpace);
    if (!pose || !onFrame) return;
    onFrame(pose.views, layer, frame, pose);
  };
  session.requestAnimationFrame(loop);

  const handle = {
    supported: true,
    session,
    layer,
    close() {
      running = false;
      try { layer.close(); } catch {}
      try { session.end(); } catch {}
    },
  };
  session.addEventListener('end', () => { running = false; });
  return handle;
}

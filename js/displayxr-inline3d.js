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
//     virtualDisplayHeight: 0.24,                       // metres of world the element shows
//     onFrame: (views, layer, frame) => {
//       for (const v of views) {
//         const vp = layer.getViewport(v);              // {x,y,width,height} into the canvas
//         // set your camera from v.projectionMatrix + v.transform.matrix, render into vp
//       }
//     },
//   });
//   if (!xr.supported) { /* mono fallback */ }
//
// TWO bits of renderer setup are load-bearing for the eye viewports:
//   renderer.setPixelRatio(1);        // getViewport() is ALREADY in device px, and three.js's
//                                     // setViewport()/setScissor() multiply by pixelRatio
//   renderer.setSize(w * 2, h, false) // w,h in device px: SBS needs a DOUBLE-WIDTH store,
//                                     // since getViewport() splits canvas.width in half

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

export async function startInline3D(
  canvas,
  { onFrame, referenceSpace = 'viewer', virtualDisplayHeight = 0.24 } = {}
) {
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
  //
  // virtualDisplayHeight is the scene-scale knob (the display rig's m2v): it tells the
  // runtime "this scene is composed for a display this many metres tall", and the runtime
  // scales the eye poses it reports by m2v = virtualDisplayHeight / the element's physical
  // height. Author your scene for a display that tall and render the views as-is — there is
  // no app-side scaling. Passing nothing used to leave it at 0, which the runtime clamps to
  // a 1 cm virtual display: a metre-scale scene then renders wildly oversized.
  const layer = new XRDisplayLayer(session, canvas, { virtualDisplayHeight });
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

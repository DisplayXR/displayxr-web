// The v0.4 harness cases, moved from run.mjs unchanged (the registry: every test/cases/*.mjs is
// loaded in file-name order; each default-exports (env) => case[]). They run against the DEV bundle
// (env.NEW = dist/auto3d-dev.js, built in memory) and assert through the dev surface
// (window.__dxrAuto3D.state(), the HUD, the Ctrl+Alt hotkeys), which dev.js keeps byte-compatible.
// A case may also carry its own run(page, h) / check(r, t, h) (see product.mjs).
export default function cases({ P, NEW, LEGACY, hasSog, SOG_DIR }) {
  // cfg.convTarget false on 'a': the page's setup-time camera.lookAt(0, 1, 0) is the same point the
  // estimator finds, but its distance is exact rather than estimated, and parity with the pre-split
  // script (which had no target) is about the machinery, not the new source. a-target covers it.
  return [
    // eyeScale 0.5: the pre-0.5.2 half-width eye, so this frame stays byte-comparable with the pre-split script (a-legacy).
    { id: 'a', name: 'three.js keyframes', url: P + 'three-keyframes.html', shim: NEW, cfg: { convTarget: false, eyeScale: 0.5 }, expect: 'convert', fovDeg: 40, ready: 'window.__frozen' },
    // The pre-split script defaults to depth 0.3; parity is about the machinery, not the default, so it
    // is given today's camera-rig default (0.5, 2026-09-28) through its own test config.
    { id: 'a-legacy', name: 'three.js keyframes, pre-split content.js', url: P + 'three-keyframes.html', shim: LEGACY, cfg: { depth: 0.5 }, expect: 'convert', fovDeg: 40, ready: 'window.__frozen', parityOf: 'a' },
    { id: 'a-off', name: 'three.js keyframes, site switched off', url: P + 'three-keyframes.html', shim: NEW, cfg: { enabled: false }, expect: 'idle', ready: 'window.__frozen' },
    { id: 'b', name: 'PlayCanvas meshes (ESM, no globals)', url: P + 'pc-mesh.html', shim: NEW, expect: 'convert', fovDeg: 40, ready: 'window.__frozen' },
    { id: 'a-kill', name: 'three.js keyframes, Ctrl+Alt+3 off while live, then on again (render-on-demand)', url: P + 'three-keyframes.html', shim: NEW, expect: 'convert', fovDeg: 40, ready: 'window.__frozen', killAfter: true, commits: true },
    { id: 'b-kill', name: 'PlayCanvas meshes, Ctrl+Alt+3 off while live, then on again (autoRender false)', url: P + 'pc-mesh.html', shim: NEW, expect: 'convert', fovDeg: 40, ready: 'window.__frozen', killAfter: true, commits: true },
    { id: 'a-target', name: 'three.js OrbitControls target off the scene centre', url: P + 'three-orbit.html', shim: NEW, expect: 'convert', fovDeg: 40, ready: 'window.__frozen' },
    { id: 'b-target', name: 'PlayCanvas CameraControls focusPoint off the scene centre', url: P + 'pc-orbit.html', shim: NEW, expect: 'convert', fovDeg: 40, ready: 'window.__frozen' },
    { id: 'a-display', name: 'three.js keyframes, Ctrl+Alt+P: display rig and back, per-rig depth, the joint depth control', url: P + 'three-keyframes.html', shim: NEW, cfg: { convTarget: false }, expect: 'convert', fovDeg: 40, ready: 'window.__frozen', displayAfter: true },
    // A site tuned under v0.3 stored ONE depth (applied to both rigs): it becomes the camera rig's.
    { id: 'a-migrate', name: 'three.js, a v0.3 single stored depth 0.35 -> camera 0.35, display its default 1.0', url: P + 'three-keyframes.html', shim: NEW, expect: 'migrate', seed: { v: 1, enabled: true, depth: 0.35, convScale: 1, rig: 'display', hud: true } },
    // Bug B: the no-views timer. The page draws nothing for 2.5 s once the layer exists (busy loading,
    // render on demand) and the runtime has no eyes until 3.2 s; timed from the layer (1.5 s) that is a
    // false 'no 2-view frame' stand-down, timed from the first draw (2.5 + 1.5 s) it converts.
    { id: 'b-late', name: 'PlayCanvas, page draws nothing for 2.5 s after the layer, eyes at 3.2 s (noViewsMs 1.5 s)', url: P + 'pc-mesh.html?stallMs=2500', shim: NEW, cfg: { noViewsMs: 1500 }, fake: { viewsAfterMs: 3200, noDisplayApi: true }, expect: 'convert', fovDeg: 40, ready: 'window.__frozen', lateViews: true, timeoutMs: 15000 },
    // ... and the timer still fires when the eyes never come (the fix must not disable it).
    { id: 'b-noviews', name: 'PlayCanvas, no eyes ever, no display API: back to 2D noViewsMs after the first draw', url: P + 'pc-mesh.html', shim: NEW, cfg: { noViewsMs: 1500 }, fake: { viewsAfterMs: 1e12, noDisplayApi: true }, expect: 'noviews' },
    { id: 'b-flip', name: 'PlayCanvas camera alternating perspective / orthographic every 2 s', url: P + 'pc-flip.html', shim: NEW, expect: 'flip', commits: true },
    { id: 'c', name: 'PlayCanvas gsplat ports_25.sog', url: P + 'pc-gsplat.html', shim: NEW, expect: 'convert', fovDeg: 50, ready: 'window.__splatReady', minFrames: 700, skip: hasSog ? null : `no ports_25.sog in ${SOG_DIR}` },
    { id: 'd', name: 'SDK samples/splat (must stand down)', url: '/samples/splat/index.html?engine=playcanvas&url=/bench/ports_25.sog', shim: NEW, expect: 'standdown', skip: hasSog ? null : `no ports_25.sog in ${SOG_DIR}` },
  ];
}

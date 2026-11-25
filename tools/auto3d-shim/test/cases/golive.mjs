// #339, the go-live (v0.7.10): one horizontally stretched frame on the panel as a canvas went 3D
// (three.js keyframes, the PlayCanvas car configurator, DisplayXR Browser 1.10.6). new XRDisplayLayer()
// reaches the browser on its own channel, ahead of the task's commit, and a canvas the page has had for
// a while is joined at once: created in the flip task, the browser could weave the frame committed
// BEFORE it, the page's mono picture with no cover yet (each eye half the picture, twice as wide). The
// layer now follows a frame drawn on the side-by-side store by two animation frames (core.js bindLayer).
//
// Commit model (fake-xr.js): layers[i].committedAtCreate is the frame committed before the layer, and
// the generic check (run.mjs goLiveCommitted) wants it to be the side-by-side store, under the cover.
// maxSbsWidth 1024 makes the store narrower than the page's 1280 (3072 vs 3840 on the panel), so a mono
// frame differs from the store in size as well as in the cover. The -ab cases run v0.7.9's order
// (T.bindAfterCommit false) and must see the mono frame: the check discriminates.
// The -decoy cases put a small 2D canvas ahead of the 3D one in the DOM: the check must read the
// canvas that goes live, not the page's first (fake-xr.js committedBy, each canvas on its own).
// Every other activation path (a-kill / b-kill / b-flip: on again, each perspective phase) carries the
// same check through `commits: true`.
export default function cases({ P, NEW }) {
  const base = { shim: NEW, expect: 'convert', fovDeg: 40, ready: 'window.__frozen', commits: true };
  return [
    { ...base, id: 'a-golive', name: 'three.js keyframes, go-live: the layer follows the committed side-by-side store (maxSbsWidth 1024)', url: P + 'three-keyframes.html', cfg: { maxSbsWidth: 1024 } },
    { ...base, id: 'a-golive-ab', name: 'three.js keyframes, go-live, A/B: the layer in the flip task (v0.7.9)', url: P + 'three-keyframes.html', cfg: { maxSbsWidth: 1024, bindAfterCommit: false }, goLiveExpect: 'mono' },
    { ...base, id: 'a-golive-decoy', name: 'three.js keyframes behind a small 2D canvas, go-live: the check reads the canvas that goes live', url: P + 'three-keyframes.html?decoy=1', cfg: { maxSbsWidth: 1024 } },
    { ...base, id: 'a-golive-decoy-ab', name: 'three.js keyframes behind a small 2D canvas, go-live, A/B: the layer in the flip task (v0.7.9)', url: P + 'three-keyframes.html?decoy=1', cfg: { maxSbsWidth: 1024, bindAfterCommit: false }, goLiveExpect: 'mono' },
    { ...base, id: 'b-golive', name: 'PlayCanvas meshes, go-live: the layer follows the committed side-by-side store (maxSbsWidth 1024)', url: P + 'pc-mesh.html', cfg: { maxSbsWidth: 1024 } },
    { ...base, id: 'b-golive-ab', name: 'PlayCanvas meshes, go-live, A/B: the layer in the flip task (v0.7.9)', url: P + 'pc-mesh.html', cfg: { maxSbsWidth: 1024, bindAfterCommit: false }, goLiveExpect: 'mono' },
  ];
}
